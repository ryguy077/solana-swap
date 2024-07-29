const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');
const fetch = require('node-fetch');
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const { SolanaTracker } = require('solana-swap');

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

async function getAssetsByOwner(ownerAddress) {
  const url = 'https://mainnet.helius-rpc.com/?api-key=6b96dac6-8b2c-4034-bd26-ea942a8d190f';
  let retries = 0;
  const maxRetries = 10;
  const retryDelay = 1000;

  while (retries < maxRetries) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
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
      if (!response.ok) {
        throw new Error(`HTTP status ${response.status}`);
      }
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message);
      }
      return data.result.items || [];
    } catch (error) {
      retries++;
      logMessage(`Error fetching assets for ${ownerAddress}: ${error.message}. Retrying ${retries}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay * retries));
    }
  }
  logMessage(`Failed to fetch assets for ${ownerAddress} after ${maxRetries} retries.`);
  return [];
}

async function getTokenBalances() {
  const tempWalletFiles = fs.readdirSync(tempWalletsDir).filter(file => file.endsWith('.json'));
  const tokenBalances = {};
  const promises = tempWalletFiles.map(file => new Promise(async resolve => {
    const wallet = JSON.parse(fs.readFileSync(path.join(tempWalletsDir, file)));
    const assets = await getAssetsByOwner(wallet.publicKey);
    for (const item of assets) {
      if (item.token_info) {
        const tokenId = item.id;
        const tokenSymbol = item.content.metadata.symbol;
        const balance = item.token_info.balance / Math.pow(10, item.token_info.decimals);
        if (!tokenBalances[tokenId]) {
          tokenBalances[tokenId] = {
            totalBalance: 0,
            wallets: [],
            symbol: tokenSymbol,
            priceInfo: item.token_info.price_info || { total_price: 0 },
          };
        }
        tokenBalances[tokenId].totalBalance += balance;
        tokenBalances[tokenId].wallets.push({
          publicKey: wallet.publicKey,
          secretKey: wallet.secretKey,
          balance,
        });
      }
    }
    resolve();
  }));
  await Promise.all(promises);
  return tokenBalances;
}

async function promptUserForToken(tokenBalances) {
  const tokenChoices = Object.keys(tokenBalances).map(tokenId => ({
    name: `${tokenBalances[tokenId].symbol} - ${tokenBalances[tokenId].totalBalance.toFixed(6)} - ${tokenBalances[tokenId].priceInfo.total_price.toFixed(2)} USD`,
    value: tokenId,
  })).sort((a, b) => b.totalBalance - a.totalBalance);

  const { selectedToken } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedToken',
      message: 'Select the token to swap to SOL:',
      choices: tokenChoices,
    },
  ]);

  const { priorityFee, slippage } = await inquirer.prompt([
    {
      type: 'input',
      name: 'priorityFee',
      message: 'Enter the priority fee per transaction (recommended during network congestion):',
      default: '0.0005',
      validate: value => !isNaN(value) && value >= 0 ? true : 'Please enter a valid priority fee.',
    },
    {
      type: 'input',
      name: 'slippage',
      message: 'Enter the slippage percentage (0 to 100):',
      default: '30',
      validate: value => !isNaN(value) && value >= 0 && value <= 100 ? true : 'Please enter a valid slippage percentage.',
    },
  ]);

  return { selectedToken, priorityFee, slippage };
}

async function swapTokens(walletData, selectedToken, priorityFee, slippage) {
  const keypair = Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
  const solanaTracker = new SolanaTracker(keypair, 'https://rpc.solanatracker.io/public?advancedTx=true');
  const amount = walletData.balance;

  logMessage(`Swapping ${amount.toFixed(4)} ${selectedToken} from wallet ${walletData.publicKey}...`);

  const swapRequestData = {
    fromMint: selectedToken,
    toMint: 'So11111111111111111111111111111111111111112',
    amount,
    slippage,
    owner: keypair.publicKey.toBase58(),
    priorityFee
  };

  logMessage(`Swap request data: ${JSON.stringify(swapRequestData)}`);

  const swapResponse = await solanaTracker.getSwapInstructions(
    swapRequestData.fromMint,
    swapRequestData.toMint,
    swapRequestData.amount,
    swapRequestData.slippage,
    swapRequestData.owner,
    swapRequestData.priorityFee
  );

  let retries = 0;
  const maxRetries = 10;
  const retryDelay = 1000;

  while (retries < maxRetries) {
    try {
      const txid = await solanaTracker.performSwap(swapResponse, {
        sendOptions: { skipPreflight: true },
        confirmationRetries: 30,
        confirmationRetryTimeout: 500,
        lastValidBlockHeightBuffer: 150,
        resendInterval: 1000,
        confirmationCheckInterval: 1000,
        commitment: 'processed',
        skipConfirmationCheck: false
      });
      logMessage(`Transaction ID: ${txid}`);
      logMessage(`Transaction URL: https://solscan.io/tx/${txid}`);
      await connection.confirmTransaction(txid, 'confirmed');
      logMessage(`Transaction confirmed: ${txid}`);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
      return;
    } catch (error) {
      retries++;
      logMessage(`Error performing swap for wallet ${keypair.publicKey.toBase58()}: ${error.message}. Retrying ${retries}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay * retries));
    }
  }
  logMessage(`Failed to swap tokens for wallet ${keypair.publicKey.toBase58()} after ${maxRetries} retries.`);
}

async function main() {
  logMessage('Starting script...');

  const tokenBalances = await getTokenBalances();
  const { selectedToken, priorityFee, slippage } = await promptUserForToken(tokenBalances);

  logMessage(`Swapping all balances of ${selectedToken} to SOL with priority fee ${priorityFee} and slippage ${slippage}%`);

  const wallets = tokenBalances[selectedToken].wallets;

  // Limit concurrency to avoid rate limits
  const concurrencyLimit = 1;
  const delayBetweenRequests = 5000; // Increased delay to handle rate limiting

  const promiseQueue = [];
  for (let i = 0; i < wallets.length; i++) {
    promiseQueue.push(swapTokens(wallets[i], selectedToken, priorityFee, slippage));
    if (promiseQueue.length >= concurrencyLimit) {
      await Promise.all(promiseQueue);
      promiseQueue.length = 0;
      await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
    }
  }
  if (promiseQueue.length > 0) {
    await Promise.all(promiseQueue);
  }

  logMessage('Script completed successfully.');
}

main().catch(error => {
  logMessage(`Error: ${error.message}`);
});
