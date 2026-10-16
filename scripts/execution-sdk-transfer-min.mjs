// Anvil-only execution checks for transferMin paths without dedicated UI scenarios.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as sdkLib from '@eulerxyz/euler-v2-sdk'
import * as viem from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, i, all) => item.startsWith('--') ? [...pairs, [item.slice(2), all[i + 1]]] : pairs, []))
const outputDir = path.resolve(flags['output-dir'] ?? 'artifacts/execution-recordings/sdk-transfer-min')
const appUrl = flags.url ?? 'http://127.0.0.1:3001'
fs.mkdirSync(outputDir, { recursive: true })
const jiti = createJiti(root + '/package.json', { alias: { '~': root } })
const { collectPlanningRequirements } = await jiti.import(root + '/features/reviewed-execution/planning/requirements.ts')
const { createOperationIntent } = await jiti.import(root + '/features/reviewed-execution/domain/factory.ts')
const { createAppSnapshotDependencies } = await jiti.import(root + '/features/reviewed-execution/planning/app-snapshot.ts')
const { GenerationPublisher, PreparationCache } = await jiti.import(root + '/features/reviewed-execution/planning/cache.ts')
const { PlanningSnapshotLoader } = await jiti.import(root + '/features/reviewed-execution/planning/snapshot-loader.ts')
const { normalizeSdkPlan } = await jiti.import(root + '/tests/golden/normalize.ts')
const fixture = JSON.parse(fs.readFileSync(path.resolve(flags.fixture ?? root + '/tests/execution/anvil-mainnet.fixture.json'), 'utf8'))
assert.equal(fixture.chainId, 1, 'This fixture covers Ethereum deployments')
const rpcUrl = flags['anvil-rpc'] ?? fixture.anvil.rpcUrl
const transport = viem.http(rpcUrl)
const client = viem.createPublicClient({ chain: mainnet, transport })
assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i)
const forkInfo = await client.request({ method: 'anvil_nodeInfo' })
assert.equal(forkInfo.forkConfig?.forkBlockNumber, fixture.forkBlockNumber, 'Start Anvil at the fixture fork block')
const signer = privateKeyToAccount(fixture.wallet.privateKey)
assert.equal(signer.address, viem.getAddress(fixture.wallet.address))
const wallet = viem.createWalletClient({ account: signer, chain: mainnet, transport })
const sdk = await sdkLib.buildEulerSDK({ config: {
  rpcUrls: { 1: rpcUrl },
  deploymentsUrl: appUrl + '/api/internal/euler-chains',
  swapApiUrl: flags['swap-api-url'] ?? 'https://swap-dev.euler.finance', disableV3: true,
  accountServiceAdapter: 'onchain', eVaultServiceAdapter: 'onchain', eulerEarnServiceAdapter: 'onchain',
} })
const account = new sdkLib.Account({ chainId: 1, owner: signer.address, subAccounts: {} })
const vaultAbi = viem.parseAbi(['function asset() view returns(address)', 'function totalAssets() view returns(uint256)', 'function totalSupply() view returns(uint256)'])
// Supply Nuxt auto-import dependencies in this isolated Node process. Object.assign
// keeps these test adapters from augmenting the app's global TypeScript types.
Object.assign(globalThis, {
  useVaultRegistry: () => ({
    getOrFetch: async (address) => {
      const read = functionName => client.readContract({ address, abi: vaultAbi, functionName })
      const [asset, totalAssets, totalShares] = await Promise.all([read('asset'), read('totalAssets'), read('totalSupply')])
      return { chainId: 1, address, asset: { address: asset }, totalAssets, totalShares }
    },
    getType: () => 'earn',
  }),
  useTokenList: () => ({ getTokenByAddress: () => undefined }),
})
const loadSnapshot = async (requirements) => {
  const generation = new GenerationPublisher()
  const loader = new PlanningSnapshotLoader(new PreparationCache(), createAppSnapshotDependencies({
    account, getBlockNumber: () => client.getBlockNumber(), dataVersion: 'fork', labelsVersion: 'fork',
  }), generation, 'fork')
  return loader.load(requirements, generation.current())
}
const input = fixture.tokens.find(t => t.symbol === 'USDC')
const output = fixture.tokens.find(t => t.symbol === 'WETH')
const amount = viem.parseUnits('1', input.decimals)
assert.equal(await client.getChainId(), fixture.chainId)
const latest = await client.getBlock()
await client.request({ method: 'evm_setNextBlockTimestamp', params: [Math.max(Number(latest.timestamp) + 1, Math.floor(Date.now() / 1000))] })
await client.request({ method: 'evm_mine', params: [] })
await client.request({ method: 'anvil_setCode', params: [signer.address, '0x'] })
await client.request({ method: 'anvil_setBalance', params: [signer.address, viem.toHex(viem.parseEther('1000'))] })
await client.request({ method: 'anvil_setBalance', params: [input.whale, viem.toHex(viem.parseEther('10'))] })
const seedHash = await client.request({ method: 'eth_sendTransaction', params: [{ from: input.whale, to: input.address, data: viem.encodeFunctionData({ abi: viem.erc20Abi, functionName: 'transfer', args: [signer.address, viem.parseUnits('100', input.decimals)] }), gas: '0x30d40' }] })
assert.equal((await client.waitForTransactionReceipt({ hash: seedHash })).status, 'success')
const evc = sdk.deploymentService.getDeployment(1).addresses.coreAddrs.evc
const prepareExecutableQuote = async (quotes, makePlan) => {
  for (const quote of quotes.filter(q => !q.route.some(h => h.providerName.toLowerCase().includes('cow')))) {
    try {
      const plan = await makePlan(quote)
      const prepared = await sdk.executionService.prepareTransactionPlan({ plan, chainId: 1, account: signer.address, usePermit2: false, unlimitedApproval: false })
      await sdk.executionService.estimateGasForPreparedTransactionPlan(prepared, { stateOverrides: true })
      return { quote, prepared }
    }
    catch (error) {
      console.log(JSON.stringify({ rejectedProvider: quote.route, reason: String(error.shortMessage ?? error.message).slice(0, 500) }))
    }
  }
  throw new Error('No live quote executes against this fork state')
}
const results = []
for (const receiver of [signer.address, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8']) {
  const quotes = await sdk.swapService.fetchWalletSwapQuote({ chainId: 1, fromAsset: input.address, toAsset: output.address, amount, receiver, origin: signer.address, slippage: 5 })
  const { quote, prepared } = await prepareExecutableQuote(quotes, quote => sdk.executionService.planSwapFromWallet({ account, swapQuote: quote, amount, tokenIn: input.address }))
  assert.equal(quote.verify.type, 'transferMin')
  assert.equal(quote.verify.vault.toLowerCase(), receiver.toLowerCase())
  const intent = createOperationIntent({ kind: 'swap', planner: 'swap-from-wallet', args: { swapQuote: quote, amount, tokenIn: input.address }, chainId: 1, account: signer.address, source: 'fork-test' })
  const requirements = collectPlanningRequirements([intent])
  assert.deepEqual(requirements.vaults, [])
  await loadSnapshot(requirements)
  const balance = () => client.readContract({ address: output.address, abi: viem.erc20Abi, functionName: 'balanceOf', args: [receiver] })
  const before = await balance()
  const transactions = normalizeSdkPlan(prepared.plan, evc)
  const receipts = []
  for (const tx of transactions) {
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value), gas: 30000000n })
    const receipt = await client.waitForTransactionReceipt({ hash })
    assert.equal(receipt.status, 'success', `Wallet swap transaction ${hash} reverted`)
    receipts.push({ hash, to: tx.to, selector: tx.data.slice(0, 10), block: String(receipt.blockNumber), status: receipt.status, evcBatch: tx.evcBatch })
  }
  const received = await balance() - before
  assert.ok(received >= BigInt(quote.amountOutMin) && received > 0n)
  results.push({ receiver, verification: quote.verify, requiredVaults: requirements.vaults, received: String(received), receipts })
  console.log(JSON.stringify({ receiver, received: String(received), hashes: receipts.map(r => r.hash) }))
}
fs.writeFileSync(path.join(outputDir, 'wallet-swaps.json'), JSON.stringify({ block: fixture.forkBlockNumber, results }, (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n')

const usdt = fixture.tokens.find(t => t.symbol === 'USDT')
const pool = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const earn = '0x3B4802FDb0E5d74aA37d58FD77d63e93d4f9A4AF'
const receipts = []
const send = async (tx) => {
  const hash = await wallet.sendTransaction({ ...tx, gas: 30000000n })
  const receipt = await client.waitForTransactionReceipt({ hash })
  assert.equal(receipt.status, 'success')
  receipts.push({ hash, to: tx.to, selector: tx.data.slice(0, 10), status: receipt.status, block: String(receipt.blockNumber) })
  return receipt
}
await client.request({ method: 'anvil_setBalance', params: [usdt.whale, viem.toHex(viem.parseEther('10'))] })
const seed = await client.request({ method: 'eth_sendTransaction', params: [{ from: usdt.whale, to: usdt.address, data: viem.encodeFunctionData({ abi: viem.erc20Abi, functionName: 'transfer', args: [signer.address, 100000000n] }), gas: '0x30d40' }] })
assert.equal((await client.waitForTransactionReceipt({ hash: seed })).status, 'success')
await send({ to: usdt.address, data: viem.encodeFunctionData({ abi: viem.erc20Abi, functionName: 'approve', args: [pool, 10000000n] }) })
await send({ to: pool, data: viem.encodeFunctionData({ abi: viem.parseAbi(['function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)']), functionName: 'supply', args: [usdt.address, 10000000n, signer.address, 0] }) })
const positionRef = { collateralAsset: usdt.address, pool }
const position = await sdk.positionMigrationService.getPosition({ connectorId: 'aave', chainId: 1, owner: signer.address, positionRef })
console.log(JSON.stringify({ sourceCollateral: String(position.collateral.amount), sourceDebt: String(position.debt.amount) }))
const verifier = sdk.deploymentService.getDeployment(1).addresses.peripheryAddrs.swapVerifier
const deadline = Math.floor(Date.now() / 1000) + 3600
const quotes = await sdk.swapService.fetchSwapQuotes({ chainId: 1, tokenIn: usdt.address, tokenOut: input.address,
  accountIn: viem.zeroAddress, accountOut: viem.zeroAddress, amount: position.collateral.amount,
  vaultIn: viem.zeroAddress, receiver: verifier, origin: signer.address, slippage: 5,
  swapperMode: 0, isRepay: false, targetDebt: 0n, currentDebt: 0n, deadline,
  unusedInputReceiver: signer.address, transferOutputToReceiver: true,
})
const migrationArgs = quote => ({ direction: 'external-to-euler', connectorId: 'aave', chainId: 1, owner: signer.address,
  positionRef, position, deadline: BigInt(deadline), collateralSwapQuote: quote,
  target: { eulerAccount: signer.address, collateralVault: earn, collateralSwapVerification: 'deposit', minCollateralAssets: BigInt(quote.amountOutMin) },
})
const { quote, prepared } = await prepareExecutableQuote(quotes, async (quote) => {
  const args = migrationArgs(quote)
  const request = await sdk.positionMigrationService.getAuthorization(args)
  assert.equal(request.kind, 'typedData')
  const signature = await signer.signTypedData(request.typedData)
  return sdk.positionMigrationService.planMigration({ ...args, authorization: { request, signature } })
})
assert.equal(quote.verify.type, 'transferMin')
assert.equal(quote.verify.vault.toLowerCase(), verifier.toLowerCase())
const args = migrationArgs(quote)
const target = args.target
const intent = createOperationIntent({ kind: 'migration', planner: 'cross-protocol-migration', args: {
  direction: args.direction, connectorId: args.connectorId, owner: signer.address, positionRef,
  target, deadline: BigInt(deadline), collateralSwapQuote: quote, authorizationEvidenceDigest: viem.zeroHash,
}, chainId: 1, account: signer.address, source: 'fork-test', constraints: [{ kind: 'maximum-input', token: usdt.address, amount: position.collateral.amount }] })
const requirements = collectPlanningRequirements([intent])
assert.deepEqual(requirements.vaults, [viem.getAddress(earn)])
await loadSnapshot(requirements)
const before = await client.readContract({ address: earn, abi: viem.erc20Abi, functionName: 'balanceOf', args: [signer.address] })
for (const tx of normalizeSdkPlan(prepared.plan, evc)) await send({ to: tx.to, data: tx.data, value: BigInt(tx.value) })
const after = await client.readContract({ address: earn, abi: viem.erc20Abi, functionName: 'balanceOf', args: [signer.address] })
assert.ok(after > before)
const result = { forkBlock: fixture.forkBlockNumber, verification: quote.verify, requiredVaults: requirements.vaults, sourcePosition: positionRef, earn, mintedShares: String(after - before), receipts }
fs.writeFileSync(path.join(outputDir, 'earn-migration.json'), JSON.stringify(result, (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n')
console.log(JSON.stringify({ mintedShares: String(after - before), requiredVaults: requirements.vaults, hashes: receipts.map(r => r.hash) }))
