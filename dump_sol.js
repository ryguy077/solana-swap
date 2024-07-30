const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');
const fetch = require('node-fetch');
const { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, PublicKey, SendTransactionError } = require('@solana/web3.js');
const bs58 = require('bs58');

const walletsDir = path.join(__dirname, 'wallets');
const tempWalletsDir = path.join(walletsDir, 'temp');
const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=6b96dac6-8b2c-4034-bd26-ea942a8d190f', 'confirmed');
const logFile = path.join(__dirname, 'transaction_log.txt');

if (!fs.existsSync(tempWalletsDir)) {
  fs.mkdirSync(tempWalletsDir, { recursive: true });
}

function logMessage(message) {
  console.log(message);
  fs.appendFileSync(logFile, message + '\n');
}

async function getAssetsWithNativeBalance(ownerAddress) {
  const url = 'https://mainnet.helius-rpc.com/?api-key=6b96dac6-8b2c-4034-bd26-ea942a8d190f';
  let retries = 0;
  const maxRetries = 10;

  while (retries < maxRetries) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'my-id',
          method: 'getAssetsByOwner',
          params: {
            ownerAddress,
            displayOptions: {
              showFungible: true,
              showNativeBalance: true,
            },
          },
        }),
      });

      if (!response.ok) throw new Error(`HTTP status ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      return data.result;
    } catch (error) {
      retries++;
      logMessage(`Error fetching assets for ${ownerAddress}: ${error.message}. Retrying ${retries}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * retries));
    }
  }
  logMessage(`Failed to fetch assets for ${ownerAddress} after ${maxRetries} retries.`);
  return { items: [], nativeBalance: { lamports: 0 } };
}

async function promptUserForMainWallet() {
  const tempWalletFiles = new Set(fs.readdirSync(tempWalletsDir).filter(file => file.endsWith('.json')));
  const allWalletFiles = fs.readdirSync(walletsDir).filter(file => file.endsWith('.json'));

  const mainWalletFiles = allWalletFiles.filter(file => !tempWalletFiles.has(file));
  const walletChoices = await Promise.all(mainWalletFiles.map(async (file) => {
    const wallet = JSON.parse(fs.readFileSync(path.join(walletsDir, file)));
    const publicKey = new PublicKey(wallet.publicKey); // Convert to PublicKey object
    const balance = (await connection.getBalance(publicKey)) / LAMPORTS_PER_SOL;
    return { name: `${publicKey.toBase58()} - ${balance.toFixed(6)} SOL`, value: wallet };
  }));

  const { selectedWallet } = await inquirer.prompt([
    { type: 'list', name: 'selectedWallet', message: 'Select the main wallet to receive SOL:', choices: walletChoices },
  ]);

  return selectedWallet;
}

async function sendSol(fromWallet, toWallet, amount) {
  const keypair = Keypair.fromSecretKey(bs58.decode(fromWallet.secretKey));
  const toPublicKey = new PublicKey(toWallet.publicKey); // Ensure this is a PublicKey object
  const lamports = Math.floor(amount * LAMPORTS_PER_SOL) - 5000; // Deduct some lamports for fees
  const transaction = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: toPublicKey, lamports })
  );

  try {
    const signature = await connection.sendTransaction(transaction, [keypair]);
    await connection.confirmTransaction(signature, 'confirmed');
    logMessage(`Transferred ${amount} SOL from ${fromWallet.publicKey} to ${toWallet.publicKey}`);
    return true;
  } catch (error) {
    if (error instanceof SendTransactionError) {
      const logs = await connection.getLogs(error.signature);
      logMessage(`Error transferring SOL from ${fromWallet.publicKey} to ${toWallet.publicKey}: ${error.message}. Logs: ${logs}`);
    } else {
      logMessage(`Error transferring SOL from ${fromWallet.publicKey} to ${toWallet.publicKey}: ${error.message}`);
    }
    return false;
  }
}

async function main() {
  logMessage('Starting dump_sol script...');

  const tempWalletFiles = fs.readdirSync(tempWalletsDir).filter(file => file.endsWith('.json'));
  
  const mainWallet = await promptUserForMainWallet();

  const mainWalletAddress = new PublicKey(mainWallet.publicKey);
  const mainWalletBalanceBefore = (await connection.getBalance(mainWalletAddress)) / LAMPORTS_PER_SOL;
  logMessage(`Main wallet initial balance: ${mainWalletBalanceBefore.toFixed(6)} SOL`);

  const concurrencyLimit = 10;
  const delayBetweenRequests = 1000; // Milliseconds

  const balancePromises = tempWalletFiles.map(file => {
    const wallet = JSON.parse(fs.readFileSync(path.join(tempWalletsDir, file)));
    wallet.publicKey = new PublicKey(wallet.publicKey); // Convert to PublicKey object
    return getAssetsWithNativeBalance(wallet.publicKey.toBase58()).then(({ nativeBalance }) => ({
      wallet,
      balance: nativeBalance.lamports / LAMPORTS_PER_SOL,
    }));
  });

  const results = [];
  for (let i = 0; i < balancePromises.length; i += concurrencyLimit) {
    const batch = balancePromises.slice(i, i + concurrencyLimit);
    results.push(...await Promise.all(batch));
    await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
  }

  const totalAmountToTransfer = results.reduce((sum, { balance }) => sum + balance, 0);
  logMessage(`Total SOL to be transferred: ${totalAmountToTransfer.toFixed(6)} SOL`);

  let successfulTransfers = 0;
  const transferPromises = results.map(async ({ wallet, balance }) => {
    if (balance > 0) {
      const success = await sendSol(wallet, mainWallet, balance);
      if (success) successfulTransfers++;
    }
  });

  await Promise.all(transferPromises);

  const totalTransferred = results.reduce((sum, { balance }) => sum + balance, 0);
  const mainWalletBalanceAfter = (await connection.getBalance(mainWalletAddress)) / LAMPORTS_PER_SOL;
  const successRate = (successfulTransfers / results.length) * 100;

  logMessage(`Total SOL transferred: ${totalTransferred.toFixed(6)} SOL`);
  logMessage(`Main wallet final balance: ${mainWalletBalanceAfter.toFixed(6)} SOL`);
  logMessage(`Percentage of successful transfers: ${successRate.toFixed(2)}%`);

  logMessage('dump_sol script completed successfully.');
}

main().catch(error => {
  logMessage(`Error: ${error.message}`);
});