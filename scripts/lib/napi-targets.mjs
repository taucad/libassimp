import { readFileSync } from 'node:fs';

const CPU_TO_NODE_ARCH = { aarch64: 'arm64', x86_64: 'x64' };
const SYS_TO_NODE_PLATFORM = { darwin: 'darwin', linux: 'linux', windows: 'win32' };

export const parseTriple = (triple) => {
  if (/^(?:wasm32|universal)-/u.test(triple)) throw new Error(`${triple} names no single platform package`);
  const [cpu, , system, abi] = triple.split('-');
  const platform = SYS_TO_NODE_PLATFORM[system] ?? system;
  const arch = CPU_TO_NODE_ARCH[cpu] ?? cpu;
  return {
    abi: abi ?? null,
    arch,
    platform,
    platformArchABI: abi ? `${platform}-${arch}-${abi}` : `${platform}-${arch}`,
    triple,
  };
};

export const readNapiTargets = (packageJsonPath) => {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const { binaryName, packageName, targets } = manifest.napi ?? {};
  const napiVersions = manifest.binary?.napi_versions;
  if (!binaryName || !packageName || !Array.isArray(targets) || targets.length === 0) {
    throw new Error(`${packageJsonPath} has no napi.binaryName, napi.packageName, or napi.targets`);
  }
  if (napiVersions?.length !== 1 || !Number.isSafeInteger(napiVersions[0])) {
    throw new Error(`${packageJsonPath} must declare exactly one binary.napi_versions value`);
  }
  return {
    manifest,
    napiVersion: napiVersions[0],
    packages: targets.map((triple) => {
      const target = parseTriple(triple);
      return {
        ...target,
        binary: `${binaryName}.${target.platformArchABI}.node`,
        cpu: target.arch,
        libc: target.abi === 'gnu' ? 'glibc' : undefined,
        name: `${packageName}-${target.platformArchABI}`,
        os: target.platform,
        suffix: target.platformArchABI,
      };
    }),
  };
};
