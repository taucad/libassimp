/** Node-only adapter and selection policy for the generated NAPI-RS loader. */

import { createRequire } from 'node:module';

import { AssimpError } from './assimp-error.js';
import type { CreateAssimpOptions, RuntimeLoader } from './create-assimp.js';
import type { NativeRuntime, ResolutionContext } from './convert.js';

/** Minimal generated-loader surface consumed by the facade. @internal */
export type NativeAddon = Readonly<{
  buildIdentity: string;
  napiVersion: number;
  packageVersion: string;
  preparePlan: NativeRuntime['preparePlan'];
  runPlan: (handle: unknown) => Promise<number>;
  pendingName: (handle: unknown) => string | undefined;
  supplyPlan: (handle: unknown, name: string, bytes: Uint8Array | undefined) => void;
  takePlanResult: NativeRuntime['takePlanResult'];
  destroyPlan: NativeRuntime['destroyPlan'];
}>;

/** Generated loader import kept behind the Node-conditioned graph. @internal */
export const loadNativeAddon = async (): Promise<NativeAddon> => {
  return (await import('./native/index.js')) as unknown as NativeAddon;
};

/** Adapt pending-name/supply replay to the same runtime used by Wasm. @internal */
export const adaptNativeAddon = (addon: NativeAddon): NativeRuntime => {
  const expected = `${process.platform}-${process.arch}-napi8`;
  const expectedPackageVersion = (createRequire(import.meta.url)('../package.json') as { version: string })
    .version;
  if (addon.napiVersion !== 8) {
    throw new Error(`libassimp native Node-API version mismatch: expected 8, received ${addon.napiVersion}.`);
  }
  if (addon.buildIdentity !== expected) {
    throw new Error(
      `libassimp native build identity mismatch: expected ${expected}, received ${addon.buildIdentity}.`,
    );
  }
  if (addon.packageVersion !== expectedPackageVersion) {
    throw new Error(
      `libassimp native package version mismatch: expected ${expectedPackageVersion}, received ${addon.packageVersion}.`,
    );
  }
  for (const name of [
    'preparePlan',
    'runPlan',
    'pendingName',
    'supplyPlan',
    'takePlanResult',
    'destroyPlan',
  ] as const) {
    if (typeof addon[name] !== 'function') {
      throw new TypeError(`libassimp native loader is missing '${name}'.`);
    }
  }
  return {
    backend: 'native',
    buildIdentity: addon.buildIdentity,
    preparePlan: addon.preparePlan,
    runPlan: async (handle, context: ResolutionContext) => {
      const status = await addon.runPlan(handle);
      if (status === -1) {
        const name = addon.pendingName(handle);
        if (name !== undefined) {
          context.stageNative(name, (bytes) => {
            addon.supplyPlan(handle, name, bytes);
          });
        }
      }
      return status;
    },
    takePlanResult: addon.takePlanResult,
    destroyPlan: addon.destroyPlan,
    dispose: () => undefined,
  };
};

const unavailable = (cause: unknown): AssimpError =>
  new AssimpError(
    'IMPORT_FAILED',
    `backend: native unavailable on ${process.platform}-${process.arch}; reinstall libassimp and its matching optional dependency.`,
    { cause },
  );

const warn = (options: CreateAssimpOptions, error: AssimpError): void => {
  if (options.onLog === undefined) console.warn(error.message, error.cause);
  else options.onLog({ level: 'warning', message: error.message, cause: error.cause });
};

/** Select native or Wasm without caching a failed native initialization. @internal */
export const createNodeRuntimeLoader =
  (loadWasm: RuntimeLoader, loadNative: () => Promise<NativeAddon> = loadNativeAddon): RuntimeLoader =>
  async (options) => {
    const backend = options.backend ?? 'auto';
    if (backend === 'wasm') return loadWasm(options);
    try {
      return adaptNativeAddon(await loadNative());
    } catch (cause) {
      const error = unavailable(cause);
      if (backend === 'native') throw error;
      warn(options, error);
      return loadWasm(options);
    }
  };
