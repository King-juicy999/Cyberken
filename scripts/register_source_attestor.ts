import { Contract, ethers } from 'ethers';

import creditLineManagerAbi from '../src/abi/CreditLineManager.json';
import { isValidContractAddress, isValidPrivateKey } from '../shared/utils';
import { loadEnv } from '../shared/env';

loadEnv();

const main = async () => {
  const args = process.argv.slice(2);

  if (args.length > 1) {
    console.error(`
  Usage:
    yarn manager:register_attestor [SourceCollateralAttestorAddress]

  If no address is provided, SOURCE_COLLATERAL_ATTESTOR_ADDRESS from the .env file is used.

  Example:
    yarn manager:register_attestor 0x5FbDB2315678afecb367f032d93F642f64180aa3
  `);
    process.exit(1);
  }

  const creditLineManagerAddress = process.env.CREDIT_LINE_MANAGER_CONTRACT_ADDRESS;
  const ccNextRpcUrl = process.env.CREDITCOIN_RPC_URL;
  const ccNextWalletPrivateKey = process.env.CREDITCOIN_WALLET_PRIVATE_KEY;

  // Allow overriding the source attestor address via CLI, otherwise fall back to the .env value
  const sourceAttestorAddress = args[0] ?? process.env.SOURCE_COLLATERAL_ATTESTOR_ADDRESS;

  if (!ccNextRpcUrl) {
    throw new Error('CREDITCOIN_RPC_URL environment variable is not configured or invalid');
  }

  if (!isValidContractAddress(creditLineManagerAddress)) {
    throw new Error('CREDIT_LINE_MANAGER_CONTRACT_ADDRESS environment variable is not configured or invalid');
  }

  // The credit line manager is Ownable, so registration must be done by the owner (the deployer account)
  if (!isValidPrivateKey(ccNextWalletPrivateKey)) {
    throw new Error('CREDITCOIN_WALLET_PRIVATE_KEY environment variable is not configured or invalid');
  }

  if (!isValidContractAddress(sourceAttestorAddress)) {
    throw new Error(
      'No valid source attestor address provided (pass it as an argument or set SOURCE_COLLATERAL_ATTESTOR_ADDRESS in your .env file)'
    );
  }

  // 1. Connect to the credit line manager contract on the Creditcoin chain
  const ccProvider = new ethers.JsonRpcProvider(ccNextRpcUrl);
  const wallet = new ethers.Wallet(ccNextWalletPrivateKey!, ccProvider);
  const managerContract = new Contract(creditLineManagerAddress!, creditLineManagerAbi, wallet);

  // 2. Register the Sepolia CollateralAttestor authorized to emit the facts we act upon.
  //    The manager will reject any CollateralFactRecorded event not emitted by this address.
  try {
    console.log('Registering source collateral attestor: ', sourceAttestorAddress);
    const tx = await managerContract.registerSourceCollateralAttestor(sourceAttestorAddress);
    await tx.wait();
    console.log('Source collateral attestor registered with transaction hash: ', tx.hash);
  } catch (error: any) {
    console.error('Error registering source collateral attestor: ', error.shortMessage ?? error.message);
    process.exit(1);
  }

  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });