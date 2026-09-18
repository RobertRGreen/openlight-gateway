import type { Logger } from 'pino';
import { loadConfig, type GatewayConfig } from '../config/index.js';
import { GatewayStore } from '../persistence/index.js';
import { createLogger } from '../security/logger.js';
import { TokenService } from '../security/index.js';
import { DomainBus } from '../core/events.js';
import { AdapterRuntime } from '../adapters/runtime.js';
import { MockAdapter } from '../adapters/mock/index.js';
import { GoveeAdapter } from '../adapters/govee/index.js';
import { GoveeCloudAdapter } from '../adapters/govee/cloud-adapter.js';
import { NodeGoveeTransport, type GoveeTransport } from '../adapters/govee/transport.js';
import { FeitAdapter, type FeitDeviceConfig } from '../adapters/feit/index.js';
import { NodeFeitTransport, type FeitTransport } from '../adapters/feit/transport.js';
import { DeviceRegistry } from '../core/devices/index.js';
import { OperationService } from '../core/operations/index.js';
import { RoomService } from '../core/rooms/index.js';
import { GroupService } from '../core/groups/index.js';
import { SceneService } from '../core/scenes/index.js';
import { EffectService } from '../core/effects/index.js';
import { MdnsAdvertiser } from '../discovery/mdns-advertiser.js';

export interface CompositionOptions {
  config?: GatewayConfig;
  logger?: Logger;
  deferReady?: boolean;
  goveeTransport?: GoveeTransport;
  feitTransport?: FeitTransport;
}

/** The API layer owns its listener and can import these services independently. */
export async function createGateway(options: CompositionOptions = {}) {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config.logLevel);
  const store = new GatewayStore(config.databasePath);
  const cleanup: { order: number; run: () => void | Promise<void> }[] = [
    { order: 100, run: () => store.close() },
  ];
  let notifyStopping = () => {};
  let shutdownStarted = false;
  const beginShutdown = () => { if (!shutdownStarted) { shutdownStarted = true; notifyStopping(); } };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      beginShutdown();
      const failures: unknown[] = [];
      for (const action of cleanup.sort((a, b) => a.order - b.order)) {
        try { await action.run(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Core cleanup failed');
    })();
    return stopping;
  };

  try {
    const interruptedDevices = store.recoverOperations();
    const bus = new DomainBus(store.gatewayId, () => {
      logger.error({ errorCategory: 'event_listener' }, 'Domain event listener failed');
    });
    notifyStopping = () => { bus.publish('gateway.stopping', { type: 'gateway', id: store.gatewayId }, { reason: 'shutdown' }); };
    const runtime = new AdapterRuntime(bus, logger, { timeoutMs: config.adapterTimeoutMs });
    cleanup.push({ order: 10, run: () => runtime.close() });
    const registry = new DeviceRegistry(store, runtime, bus);
    cleanup.push({ order: 20, run: () => registry.close() });
    const operations = new OperationService(store, registry, runtime, bus, logger);
    cleanup.push({ order: 30, run: () => operations.drain() });
    const rooms = new RoomService(store, registry, bus);
    cleanup.push({ order: 40, run: () => rooms.close() });
    const groups = new GroupService(store, registry, bus);
    cleanup.push({ order: 40, run: () => groups.close() });
    operations.setGroupResolver(id => groups.get(id).deviceIds);
    const scenes = new SceneService(store, groups, operations, bus);
    const effects = new EffectService(store, registry, runtime, operations, bus);
    cleanup.push({ order: 0, run: () => effects.close() });
    const tokens = new TokenService(store, config.apiTokenSalt);
    const mdns = new MdnsAdvertiser({
      gatewayName: config.gatewayName, port: config.port,
      protocol: config.tlsMode === 'disabled' ? 'http' : 'https', apiVersion: 'v1',
    }, logger);
    cleanup.push({ order: 50, run: () => mdns.stop() });
    const mock = new MockAdapter({ latencyMs: config.mockLatencyMs });
    runtime.register(mock);

    await runtime.connect(mock.id);
    await registry.discover(mock.id);
    // Discovery has already reconciled registered devices. Explicitly refresh any
    // interrupted targets so stale desired intent is never replayed on startup.
    await Promise.all(interruptedDevices.map(async id => {
      const device = registry.list().find(item => item.id === id);
      if (device && runtime.list().some(adapter => adapter.id === device.adapter)) await registry.refresh(id);
    }));
    registry.startPolling();
    // Govee discovery requires LAN Control enabled manually in Govee Home.
    // Keep optional network startup off the mock/API readiness path.
    if (config.goveeAdapterEnabled) {
      const startGovee = (async () => {
        try {
          const govee = new GoveeAdapter({
            transport: options.goveeTransport ?? new NodeGoveeTransport(),
            discoveryTimeoutMs: Math.min(config.goveeDiscoveryTimeoutMs, config.adapterTimeoutMs - 25),
            logger: { warn: message => logger.warn({ adapter: 'govee' }, message) },
          });
          runtime.register(govee);
          await runtime.connect(govee.id);
          if (!shutdownStarted) await registry.discover(govee.id);
        } catch {
          if (!shutdownStarted) logger.warn({ adapter: 'govee', errorCategory: 'startup' }, 'Govee startup failed; mock and API remain available');
        }
      })();
      // Runtime close aborts adapter calls first; drain discovery before closing storage.
      cleanup.push({ order: 15, run: () => startGovee });
    }
    if (config.goveeCloudAdapterEnabled) {
      if (!config.goveeApiKey.trim()) {
        logger.error({ adapter: 'govee-cloud', errorCategory: 'configuration' }, 'GOVEE_CLOUD_ADAPTER_ENABLED requires a non-empty GOVEE_API_KEY; Govee Cloud startup failed; mock, API, and LAN remain available');
      } else {
        const startGoveeCloud = (async () => {
          try {
            const cloud = new GoveeCloudAdapter({
              apiKey: config.goveeApiKey,
              commandTimeoutMs: config.adapterTimeoutMs,
              logger: { warn: message => logger.warn({ adapter: 'govee-cloud' }, message) },
            });
            runtime.register(cloud);
            await runtime.connect(cloud.id);
            if (!shutdownStarted) await registry.discover(cloud.id);
          } catch {
            if (!shutdownStarted) logger.warn({ adapter: 'govee-cloud', errorCategory: 'startup' }, 'Govee Cloud startup failed; mock, API, and LAN remain available');
          }
        })();
        cleanup.push({ order: 15, run: () => startGoveeCloud });
      }
    }
    if (config.feitAdapterEnabled) {
      const startFeit = (async () => {
        let feit: FeitAdapter;
        try {
          const devices: unknown = JSON.parse(config.feitDevices);
          if (!Array.isArray(devices) || devices.length === 0) throw new Error('Invalid Feit inventory');
          feit = new FeitAdapter({
            devices: devices as FeitDeviceConfig[],
            transport: options.feitTransport ?? new NodeFeitTransport(),
            // Leave time for Feit's response classification before the runtime deadline.
            commandTimeoutMs: Math.max(1, config.adapterTimeoutMs - 25),
            logger: { warn: message => logger.warn({ adapter: 'feit' }, message) },
          });
        } catch {
          logger.error({ adapter: 'feit', errorCategory: 'configuration' }, 'FEIT_ADAPTER_ENABLED requires FEIT_DEVICES to be a non-empty JSON array of valid device configurations; Feit startup failed; other adapters and API remain available');
          return;
        }
        try {
          runtime.register(feit);
          await runtime.connect(feit.id);
          if (!shutdownStarted) await registry.discover(feit.id);
        } catch {
          if (!shutdownStarted) logger.error({ adapter: 'feit', errorCategory: 'startup' }, 'Feit startup failed; verify FEIT_DEVICES and protocol version 3.3; other adapters and API remain available');
        }
      })();
      cleanup.push({ order: 15, run: () => startFeit });
    }
    let ready = false;
    const markReady = () => {
      if (ready || shutdownStarted) return;
      if (config.mdnsEnabled) mdns.start();
      ready = true;
      bus.publish('gateway.started', { type: 'gateway', id: store.gatewayId }, { reason: 'startup' });
    };
    if (!options.deferReady) markReady();
    return { config, logger, store, bus, runtime, registry, operations, rooms, groups, scenes, effects, tokens, mdns, stop,
      markReady, beginShutdown, isStopping: () => shutdownStarted, isReady: () => ready && !shutdownStarted };
  } catch (error) {
    await stop().catch(() => { logger.error({ errorCategory: 'cleanup' }, 'Startup cleanup failed'); });
    throw error;
  }
}

export type Gateway = Awaited<ReturnType<typeof createGateway>>;
