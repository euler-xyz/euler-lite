export const vaultFactoryConfigAbi = [{
  type: 'function',
  name: 'getProxyConfig',
  stateMutability: 'view',
  inputs: [{ name: 'proxy', type: 'address' }],
  outputs: [{
    name: 'config',
    type: 'tuple',
    components: [
      { name: 'upgradeable', type: 'bool' },
      { name: 'implementation', type: 'address' },
      { name: 'trailingData', type: 'bytes' },
    ],
  }],
}] as const
