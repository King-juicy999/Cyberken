import { Contract, JsonRpcApiProvider } from 'ethers';

import { proofProvider, chainInfo } from '@gluwa/usc-sdk';

/**
 * Tries to generate a proof for the given transaction hash on the specified chain. Will fail if the
 * transaction does not exist or if the block containing the transaction has not been mined yet. Will
 * also wait for the block to be attested on Creditcoin before generating the proof. May take several
 * minutes depending on how fast the attestation happens.
 * @param txHash Transaction hash on the source chain to generate the proof for.
 * @param chainKey Chain key identifying the source chain on the Creditcoin network.
 * @param proofBuilderUrl Url of the proof builder service.
 * @param creditcoinRpc A JsonRpcApiProvider connected to the Creditcoin network.
 * @param sourceChainRpc A JsonRpcApiProvider connected to the source chain.
 * @returns Promise that resolves to a ProofResult containing the proof data if successful.
 */
export async function generateProofFor(
  txHash: string,
  chainKey: number,
  proofBuilderUrl: string,
  creditcoinRpc: JsonRpcApiProvider,
  sourceChainRpc: JsonRpcApiProvider
): Promise<proofProvider.ProofResult> {
  // Wait until the fact tx is mined (the demo submits immediately after the cast send).
  console.log(`Waiting for transaction ${txHash} to be mined on source chain...`);
  const receipt = await sourceChainRpc.waitForTransaction(txHash, 1, 120_000);
  if (!receipt || receipt.blockNumber == null) {
    throw new Error(`Transaction ${txHash} is not yet mined on source chain`);
  }

  const blockNumber = receipt.blockNumber;
  console.log(`Transaction ${txHash} found in block ${blockNumber}`);

  // Now that we have the block number, we can listen for the required attestation
  // to land in the cache of the proof builder.
  const proofBuilder = new proofProvider.service.ProofBuilder(chainKey, proofBuilderUrl);
  const info = new chainInfo.PrecompileChainInfoProvider(creditcoinRpc);

  console.log(`Waiting for block ${blockNumber} attestation on Creditcoin...`);

  const latestAttested = await info.getLatestAttestedHeightAndHash(chainKey);
  console.log(`Latest attested height for chain key ${chainKey}: ${latestAttested.height}`);

  // We wait for at most 20 minutes for the attestation to be available in the proof builder cache.
  // In practice this should take about 8 minutes, but we're being conservative to make the flow robust.
  await proofBuilder.waitUntilHeightAttested(chainKey, blockNumber, 15_000, 1_200_000);

  console.log(`Block ${blockNumber} attested! Generating proof...`);

  // We can now proceed to generate the proof using the proof builder service.
  try {
    const proof = await proofBuilder.getProof(txHash);
    console.log('Proof generation successful!');
    return proof;
  } catch (error) {
    console.error('Error during proof generation: ', error);
    throw error;
  }
}

async function computeGasLimit(
  provider: JsonRpcApiProvider,
  contract: Contract,
  data: string,
  from: string,
  continuityLength: number
): Promise<bigint> {
  const GAS_BUFFER_MULTIPLIER = 135; // 100% + 35% buffer
  // Estimate gas and add buffer
  console.log('⏳ Estimating gas...');

  let gasLimit;
  try {
    const estimatedGas = await provider.estimateGas({
      to: contract.getAddress(),
      data,
      from,
    });
    gasLimit = (estimatedGas * BigInt(GAS_BUFFER_MULTIPLIER)) / BigInt(100);
    console.log(`   Estimated gas: ${estimatedGas.toString()}, Gas limit with buffer: ${gasLimit.toString()}`);
  } catch (error: any) {
    // Gas estimation can fail even when the call would succeed.
    // This is a known issue with precompiles - pallet-evm doesn't always
    // properly propagate revert reasons during estimation mode.
    // Calculate a reasonable estimate based on continuity proof size (matching Rust logic).
    // Base: 21000 (tx) + ~5000 per continuity block + ~10000 for merkle + overhead.
    const calculatedGas = 21000 + continuityLength * 5000 + 20000;
    console.warn(`   Gas estimation failed: ${error.shortMessage}`);
    console.log(
      `   Using calculated gas limit based on proof size: ${calculatedGas} (${continuityLength} continuity blocks)`
    );
    gasLimit = BigInt(calculatedGas);
  }

  return gasLimit;
}

/**
 * Computes the gas limit for submitting a credit-line proof to the CreditLineManager.
 * @param provider A JsonRpcApiProvider connected to the Creditcoin network.
 * @param contract The credit line manager contract.
 * @param proofData A proof data object obtained from the proof generation process.
 * @param signerAddress The address that will sign the submission.
 */
export async function computeGasLimitForCreditLineManager(
  provider: JsonRpcApiProvider,
  contract: Contract,
  proofData: proofProvider.ContinuityResponse,
  signerAddress: string
): Promise<bigint> {
  const action = 0; // See ManagerActions in CreditLineManager.sol: UnlockCreditLine = 0
  const chainKey = proofData.chainKey;
  const height = proofData.headerNumber;
  const encodedTransaction = proofData.txBytes;
  const merkleRoot = proofData.merkleProof.root;
  const siblings = proofData.merkleProof.siblings;
  const lowerEndpointDigest = proofData.continuityProof.lowerEndpointDigest;
  const continuityRoots = proofData.continuityProof.roots;

  const iface = contract.interface;
  const funcFragment = iface.getFunction(
    'execute(uint8,uint64,uint64,bytes,bytes32,tuple(bytes32,bool)[],bytes32,bytes32[])'
  );

  const params = [
    action,
    chainKey,
    height,
    encodedTransaction,
    merkleRoot,
    siblings,
    lowerEndpointDigest,
    continuityRoots,
  ];
  const data = iface.encodeFunctionData(funcFragment!, params);

  const continuityBlocks = proofData.continuityProof.roots?.length || 1;

  return computeGasLimit(provider, contract, data, signerAddress, continuityBlocks);
}

/**
 * Submits the proof of a CollateralFactRecorded event to the CreditLineManager contract.
 * @param contract The credit line manager contract.
 * @param proofData A proof data object obtained from the proof generation process.
 * @param gasLimit The gas limit for the submission.
 * @returns A promise that resolves to the transaction response of the execute call.
 */
export async function submitUnlockProofToCreditLineManager(
  contract: Contract,
  proofData: proofProvider.ContinuityResponse,
  gasLimit: bigint
): Promise<any> {
  const action = 0; // `UnlockCreditLine` in ManagerActions
  const chainKey = proofData.chainKey;
  const height = proofData.headerNumber;
  const encodedTransaction = proofData.txBytes;
  const merkleRoot = proofData.merkleProof.root;
  const siblings = proofData.merkleProof.siblings;
  const lowerEndpointDigest = proofData.continuityProof.lowerEndpointDigest;
  const continuityRoots = proofData.continuityProof.roots;

  return await contract.execute(
    action,
    chainKey,
    height,
    encodedTransaction,
    merkleRoot,
    siblings,
    lowerEndpointDigest,
    continuityRoots,
    { gasLimit }
  );
}

export function isValidPrivateKey(key: string | undefined): boolean {
  return !!key && key.startsWith('0x') && key.length === 66;
}

export function isValidContractAddress(address: string | undefined): boolean {
  return !!address && address.startsWith('0x') && address.length === 42;
}