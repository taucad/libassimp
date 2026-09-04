/** Node-only adapter and selection policy for the generated NAPI-RS loader. */

import packageMetadata from '../package.json' with { type: 'json' };
import { AssimpError } from './assimp-error.js';
import type { CreateAssimpOptions, RuntimeLoader } from './create-assimp.js';
import type { NativeRuntime, ResolutionContext, ResolutionResult } from './convert.js';

type NativeSettlement = (status: 0 | 1 | 2 | 3, bytes?: Uint8Array) => void;
type NativeResolveRequest = (name: string, settle: NativeSettlement) => void;

const nativeStatus: Readonly<Record<ResolutionResult['status'], 0 | 1 | 2 | 3>> = {
  missing: 0,
  found: 1,
  failed: 2,
  aborted: 3,
};

/** Minimal generated-loader surface consumed by the facade. @internal */
export type NativeAddon = Readonly<{
  buildIdentity: string;
  napiVersion: number;
  packageVersion: string;
  preparePlan: NativeRuntime['preparePlan'];
  runPlan: (handle: unknown, resolveRequest: NativeResolveRequest) => Promise<number>;
  cancelPlan: NativeRuntime['cancelPlan'];
  takePlanResult: NativeRuntime['takePlanResult'];
  destroyPlan: NativeRuntime['destroyPlan'];
}>;

const expectedNapiVersion = packageMetadata.binary.napi_versions[0];

/** Generated loader import kept behind the Node-conditioned graph. @internal */
export const loadNativeAddon = async (): Promise<NativeAddon> => {
  return import('./native/index.js');
};

/** Adapt the native resolver callback to the backend-neutral runtime. @internal */
export const adaptNativeAddon = (addon: NativeAddon): NativeRuntime => {
  const expected = `${process.platform}-${process.arch}-napi${expectedNapiVersion}`;
  if (addon.napiVersion !== expectedNapiVersion) {
    throw new Error(
      `libassimp native Node-API version mismatch: expected ${expectedNapiVersion}, received ${addon.napiVersion}.`,
    );
  }
  if (addon.buildIdentity !== expected) {
    throw new Error(
      `libassimp native build identity mismatch: expected ${expected}, received ${addon.buildIdentity}.`,
    );
  }
  if (addon.packageVersion !== packageMetadata.version) {
    throw new Error(
      `libassimp native package version mismatch: expected ${packageMetadata.version}, received ${addon.packageVersion}.`,
    );
  }
  for (const name of ['cancelPlan', 'preparePlan', 'runPlan', 'takePlanResult', 'destroyPlan'] as const) {
    if (typeof addon[name] !== 'function') {
      throw new TypeError(`libassimp native loader is missing '${name}'.`);
    }
  }
  return {
    backend: 'native',
    buildIdentity: addon.buildIdentity,
    preparePlan: addon.preparePlan,
    runPlan: (handle, context: ResolutionContext) =>
      addon.runPlan(handle, (name, settle) => {
        const deliver = (result: ResolutionResult | undefined): void => {
          result = context.currentResult(result);
          if (result === undefined) return;
          if (result.status === 'found') {
            settle(nativeStatus[result.status], result.bytes);
            context.release(name);
          } else settle(nativeStatus[result.status]);
        };
        const result = context.resolve(name);
        if (result instanceof Promise) void result.then(deliver);
        else deliver(result);
      }),
    cancelPlan: addon.cancelPlan,
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
