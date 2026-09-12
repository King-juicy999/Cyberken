import { Contract, ethers, JsonRpcApiProvider } from 'ethers';

import creditLineManagerAbi from '../src/abi/CreditLineManager.json';
import collateralAttestorAbi from '../src/abi/CollateralAttestor.json';
import { loadEnv } from '../shared/env';
import {
  computeGasLimitForCreditLineManager,
  generateProofFor,
  isValidContractAddress,
  isValidPrivateKey,
  submitUnlockProofToCreditLineManager,
} from '../shared/utils';
import { proofProvider } from '@gluwa/usc-sdk';

loadEnv();

/** Decoded CollateralFactRecorded event from the source (Sepolia) receipt. */
interface CollateralFact {
  borrower: string;
  factValue: bigint;
  timestamp: bigint;
}

/**
 * Reads the source-chain receipt of the fact-recording transaction and decodes the
 * CollateralFactRecorded event it emitted, so we know the borrower and fact value before
 * spending time (and gas) building and submitting the proof.
 */
export async function decodeCollateralFactFromReceipt(
  receipt: ethers.TransactionReceipt,
  attestor: Contract
): Promise<CollateralFact> {
  const attestorAddress = (await attestor.getAddress()).toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== attestorAddress) {
      continue;
    }
    try {
      const parsed = attestor.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'CollateralFactRecorded') {
        const [borrower, factValue, timestamp] = parsed.args;
        console.log(`Collateral fact recorded on Sepolia by ${borrower}: value=${factValue.toString()} (t=${timestamp})`);
        return { borrower: borrower as string, factValue: factValue as bigint, timestamp: timestamp as bigint };
      }
    } catch {
      // Not a parseable CollateralFactRecorded log — keep scanning.
    }
  }
  throw new Error('No CollateralFactRecorded event found in the source transaction receipt');
}

async function submitProofExecuteWithRetry(
  managerContract: Contract,
  borrower: string,
  factValue: bigint,
  proofData: proofProvider.ContinuityResponse,
  ccProvider: JsonRpcApiProvider,
  ccWalletAddress: string
): Promise<void> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Idempotency: if the proof already landed, there is nothing left to do.
    const currentLine = await managerContract.creditLines(borrower);
    if (currentLine >= factValue) {
      console.log(
        `Credit line for ${borrower} is already ${currentLine.toString()} (>= fact ${factValue.toString()}); nothing to do.`
      );
      return;
    }

    try {
      const gasLimit = await computeGasLimitForCreditLineManager(ccProvider, managerContract, proofData, ccWalletAddress);

      const response = await submitUnlockProofToCreditLineManager(managerContract, proofData, gasLimit);
      console.log(`Proof execute submitted, tx hash: ${response.hash}`);
      await response.wait();

      const newLine = await managerContract.creditLines(borrower);
      if (newLine >= factValue) {
        console.log(`Credit line unlocked/increased for ${borrower}: ${newLine.toString()} (tx hash: ${response.hash})`);
      } else {
        console.warn(`Proof mined but credit line is still ${newLine.toString()} (tx hash: ${response.hash})`);
      }
      return;
    } catch (error: any) {
      // The proof may actually have landed even though our submission errored (e.g. a
      // reverted duplicate). Confirm the current line before retrying or failing.
      const currentLine = await managerContract.creditLines(borrower);
      if (currentLine >= factValue) {
        console.log(`Credit line already at ${currentLine.toString()} — proof already applied on a prior attempt.`);
        return;
      }

      const message = error.shortMessage ?? error.message ?? String(error);
      if (attempt === maxAttempts) {
        throw new Error(`Proof execute failed after ${maxAttempts} attempts: ${message}`);
      }
      console.warn(`Proof execute attempt ${attempt} failed: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

/**
 * Prove a source-chain CollateralFactRecorded tx and submit it to the CreditLineManager on
 * Creditcoin. Uses the tx hash + proof builder (no wide eth_getLogs scans on Sepolia).
 *
 * Usage:
 *   yarn submit_collateral_proof <tx_hash>
 *   yarn submit_collateral_proof <tx_hash> --show-proof  # also dumps the proof JSON
 */
export async function submitCollateralProofAfterTx(txHash: string): Promise<void> {
  const proofBuilderUrl = process.env.PROOF_BUILDER_URL;
  const sourceChainRpcUrl = process.env.SOURCE_CHAIN_RPC_URL;
  const ccNextRpcUrl = process.env.CREDITCOIN_RPC_URL;
  const ccNextWalletPrivateKey = process.env.CREDITCOIN_WALLET_PRIVATE_KEY;
  const managerContractAddress = process.env.CREDIT_LINE_MANAGER_CONTRACT_ADDRESS;
  const sourceAttestorAddress = process.env.SOURCE_COLLATERAL_ATTESTOR_ADDRESS;
  const sourceChainKey = Number(process.env.SOURCE_CHAIN_KEY);

  if (!proofBuilderUrl) {
    throw new Error('PROOF_BUILDER_URL environment variable is not configured or invalid');
  }
  if (!sourceChainRpcUrl) {
    throw new Error('SOURCE_CHAIN_RPC_URL environment variable is not configured or invalid');
  }
  if (!ccNextRpcUrl) {
    throw new Error('CREDITCOIN_RPC_URL environment variable is not configured or invalid');
  }
  if (!isValidPrivateKey(ccNextWalletPrivateKey)) {
    throw new Error('CREDITCOIN_WALLET_PRIVATE_KEY environment variable is not configured or invalid');
  }
  if (!isValidContractAddress(managerContractAddress)) {
    throw new Error('CREDIT_LINE_MANAGER_CONTRACT_ADDRESS environment variable is not configured or invalid');
  }
  if (!isValidContractAddress(sourceAttestorAddress)) {
    throw new Error('SOURCE_COLLATERAL_ATTESTOR_ADDRESS environment variable is not configured or invalid');
  }
  if (isNaN(sourceChainKey)) {
    throw new Error('SOURCE_CHAIN_KEY environment variable is not configured or invalid');
  }

  const ccProvider = new ethers.JsonRpcProvider(ccNextRpcUrl);
  const sourceChainProvider = new ethers.JsonRpcProvider(sourceChainRpcUrl);
  const ccWallet = new ethers.Wallet(ccNextWalletPrivateKey!, ccProvider);
  const managerContract = new Contract(managerContractAddress!, creditLineManagerAbi, ccWallet);
  const attestorContract = new Contract(sourceAttestorAddress!, collateralAttestorAbi, sourceChainProvider);

  // 1. Read back the source transaction and confirm it actually records our fact.
  const sourceReceipt = await sourceChainProvider.getTransactionReceipt(txHash);
  if (!sourceReceipt) {
    throw new Error(`Transaction ${txHash} not found on the source chain`);
  }
  const { borrower, factValue } = await decodeCollateralFactFromReceipt(sourceReceipt, attestorContract);

  console.log(`CreditLineManager: ${managerContractAddress}, borrower: ${borrower}, fact: ${factValue}`);

  // 2. Do not pay for a proof if the credit line already reflects this fact.
  const currentLine = await managerContract.creditLines(borrower);
  console.log(`Current credit line for ${borrower}: ${currentLine}`);
  if (currentLine >= factValue) {
    console.log('Credit line already at or above this fact — nothing to unlock. Exiting.');
    return;
  }

  // 3. Build the Attestcoin proof (waits for source-chain attestation; several minutes).
  const proofResult = await generateProofFor(txHash, sourceChainKey, proofBuilderUrl, ccProvider, sourceChainProvider);

  if (!proofResult.success) {
    throw new Error(`Failed to generate proof: ${proofResult.error}`);
  }

  // 4. Submit the proof to the CreditLineManager on Creditcoin.
  await submitProofExecuteWithRetry(managerContract, borrower, factValue, proofResult.data!, ccProvider, ccWallet.address);

  // 5. Confirm the unlocked credit line on-chain.
  const unlockedLine = await managerContract.creditLines(borrower);
  console.log(
    `✅ Credit line for ${borrower} is now ${unlockedLine.toString()} (unlocked from ${currentLine.toString()})`
  );
}

const main = async () => {
  const args = process.argv.slice(2);

  if (args.length < 1 || args.length > 2) {
    console.error(`
  Usage:
    yarn submit_collateral_proof <CollateralFactRecordedTxHash>

  Example:
    yarn submit_collateral_proof 0x5FbDB2315678afecb367f032d93F642f64180aa3
  `);
    process.exit(1);
  }

  await submitCollateralProofAfterTx(args[0]);
};

main().catch((e) => { console.error(e); process.exit(1); });