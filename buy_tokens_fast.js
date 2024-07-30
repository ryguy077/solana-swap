const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const inquirer = require('inquirer');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
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

async function createTempWallets(numWallets, toToken) {
  const tempWallets = [];
  for (let i = 0; i < numWallets; i++) {
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const secretKey = bs58.encode(keypair.secretKey);
    const walletData = { publicKey, secretKey };
    tempWallets.push(walletData);
    const walletFile = path.join(tempWalletsDir, `temp-${toToken}-${publicKey}.json`);
    fs.writeFileSync(walletFile, JSON.stringify(walletData, null, 2));
    logMessage(`Created temporary wallet ${publicKey}`);
  }
  return tempWallets;
}

async function selectWallet() {
  const walletFiles = fs.readdirSync(walletsDir).filter(file => file.endsWith('.json'));

  if (walletFiles.length === 0) {
    console.error('No wallets found. Please create a wallet first.');
    process.exit(1);
  }

  const choices = await Promise.all(walletFiles.map(async file => {
    const walletPath = path.join(walletsDir, file);
    const walletData = JSON.parse(fs.readFileSync(walletPath));
    const publicKey = new PublicKey(walletData.publicKey);
    const balance = await connection.getBalance(publicKey) / LAMPORTS_PER_SOL;
    return {
      name: `${file.replace('.json', '')} (Balance: ${balance.toFixed(4)} SOL)`,
      value: walletPath
    };
  }));

  const { selectedWallet } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedWallet',
      message: 'Select a wallet to use for the operation:',
      choices
    }
  ]);

  const walletData = JSON.parse(fs.readFileSync(selectedWallet));
  logMessage(`Selected wallet ${walletData.publicKey}`);
  return walletData;
}

async function getTransactionDetails() {
  const questions = [
    {
      type: 'input',
      name: 'totalAmount',
      message: 'Enter the total amount of SOL to distribute:',
      validate: value => !isNaN(value) && value > 0 ? true : 'Please enter a valid amount.'
    },
    {
      type: 'input',
      name: 'numWallets',
      message: 'Enter the number of temporary wallets to create:',
      validate: value => Number.isInteger(Number(value)) && value > 0 ? true : 'Please enter a valid number.'
    },
    {
      type: 'input',
      name: 'toToken',
      message: 'Enter the address of the token to swap to:',
      validate: value => value.length === 44 ? true : 'Please enter a valid token address.'
    },
    {
      type: 'input',
      name: 'priorityFee',
      message: 'Enter the priority fee per transaction (recommended during network congestion):',
      default: '0.0005',
      validate: value => !isNaN(value) && value >= 0 ? true : 'Please enter a valid priority fee.'
    },
    {
      type: 'input',
      name: 'slippage',
      message: 'Enter the slippage percentage (0-100):',
      default: '30',
      validate: value => !isNaN(value) && value >= 0 && value <= 100 ? true : 'Please enter a valid slippage percentage (0-100).'
    }
  ];

  const answers = await inquirer.prompt(questions);
  logMessage(`Transaction details: ${JSON.stringify(answers)}`);
  return answers;
}

async function fetchTokenBalances(walletAddress) {
  const url = 'https://mainnet.helius-rpc.com/?api-key=6b96dac6-8b2c-4034-bd26-ea942a8d190f';
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
          ownerAddress: walletAddress,
          displayOptions: {
            showFungible: true,
            showNativeBalance: true,
          },
        },
      }),
    });

    const data = await response.json();
    return data.result.items;
  } catch (error) {
    console.error('Error fetching assets:', error);
    return [];
  }
}

async function fetchAllTokenBalances(tempWallets) {
  const tokenBalances = await Promise.all(tempWallets.map(async walletData => {
    const tokens = await fetchTokenBalances(walletData.publicKey);
    return tokens.map(token => ({
      publicKey: walletData.publicKey,
      secretKey: walletData.secretKey,
      ...token,
    }));
  }));

  return tokenBalances.flat();
}

async function distributeSol(fromKeypair, tempWallets, perWalletAmount, priorityFee) {
  logMessage(`Distributing SOL to temporary wallets...`);

  await Promise.all(tempWallets.map(async walletData => {
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
      const currentBalance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
      const amountNeeded = perWalletAmount - currentBalance;

      logMessage(`Processing wallet: ${JSON.stringify(walletData)}`);

      if (amountNeeded > 0) {
        const lamports = Math.floor(amountNeeded * LAMPORTS_PER_SOL);
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: fromKeypair.publicKey,
            toPubkey: keypair.publicKey,
            lamports
          })
        );

        try {
          const transactionSignature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
          logMessage(`Transaction ID: ${transactionSignature}`);
        } catch (error) {
          logMessage(`Error distributing SOL to wallet ${walletData.publicKey}: ${error.message}`);
        }
      }
    } catch (error) {
      logMessage(`Error processing wallet ${walletData.publicKey}: ${error.message}`);
    }
  }));
}

async function recycleTempWallets(tempWallets, perWalletAmount, maxWallets) {
  const walletsWithBalance = await Promise.all(tempWallets.map(async wallet => {
    const keypair = Keypair.fromSecretKey(bs58.decode(wallet.secretKey));
    const balance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
    if (balance > 0) {  // Recycle if there is any balance
      const amountNeeded = perWalletAmount - balance;
      return { publicKey: wallet.publicKey, secretKey: wallet.secretKey, balance, amountNeeded };
    }
    return null;
  }));

  const filteredWallets = walletsWithBalance.filter(wallet => wallet !== null);
  filteredWallets.sort((a, b) => b.balance - a.balance);

  logMessage(`Recycled ${filteredWallets.length} wallets with sufficient balance.`);
  return filteredWallets.slice(0, maxWallets);  // Only take up to maxWallets
}

async function swapTokens(tempWallets, toToken, priorityFee, slippage, totalAmount) {
  const amountToSwap = Number(totalAmount) / tempWallets.length;

  await Promise.all(tempWallets.map(async walletData => {
    const keypair = Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
    const solanaTracker = new SolanaTracker(keypair, 'https://rpc.solanatracker.io/public?advancedTx=true');
    const balance = await connection.getBalance(keypair.publicKey);
    const amount = (balance / LAMPORTS_PER_SOL) - priorityFee;

    if (amount <= 0) {
      logMessage(`Skipping wallet ${keypair.publicKey.toBase58()} due to insufficient balance.`);
      return;
    }

    logMessage(`Swapping ${amountToSwap.toFixed(4)} SOL from wallet ${keypair.publicKey.toBase58()}...`);
    const swapResponse = await solanaTracker.getSwapInstructions(
      'So11111111111111111111111111111111111111112',
      toToken,
      amountToSwap,
      slippage,
      keypair.publicKey.toBase58(),
      priorityFee
    );

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
    } catch (error) {
      logMessage(`Error performing swap for wallet ${keypair.publicKey.toBase58()}: ${error.message}`);
    }
  }));
}

async function main() {
  logMessage('Starting script...');
  const walletData = await selectWallet();
  const fromKeypair = Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
  const { totalAmount, numWallets, toToken, priorityFee, slippage } = await getTransactionDetails();
  const priorityFeeAmount = Number(priorityFee);
  const perWalletAmount = (Number(totalAmount) / numWallets) + 0.02;

  const existingTempWallets = fs.existsSync(tempWalletsDir)
      ? fs.readdirSync(tempWalletsDir).filter(file => file.endsWith('.json')).map(file => {
          const walletFile = fs.readFileSync(path.join(tempWalletsDir, file));
          const wallet = JSON.parse(walletFile);
          return { publicKey: wallet.publicKey, secretKey: wallet.secretKey };
      })
      : [];

  const recycledWallets = await recycleTempWallets(existingTempWallets, perWalletAmount, numWallets);
  const newWalletsNeeded = numWallets - recycledWallets.length;

  logMessage(`Recycling ${recycledWallets.length} existing temporary wallets...`);
  const newTempWallets = newWalletsNeeded > 0 ? await createTempWallets(newWalletsNeeded, toToken) : [];
  const allTempWallets = recycledWallets.concat(newTempWallets);

  if (allTempWallets.length > 0) {
      logMessage('Distributing SOL to temporary wallets...');
      await distributeSol(fromKeypair, allTempWallets, perWalletAmount, priorityFeeAmount);
  }

  logMessage('Performing swaps...');
  await swapTokens(allTempWallets, toToken, priorityFeeAmount, slippage, Number(totalAmount));

  logMessage('Script completed successfully.');

  // Print details of wallets
  logMessage('Wallet details:');
  allTempWallets.forEach(walletData => {
      logMessage(`Wallet: ${walletData.publicKey}, Balance: ${walletData.balance ? walletData.balance.toFixed(4) : '0.0000'} SOL, Amount Needed: ${walletData.amountNeeded ? walletData.amountNeeded.toFixed(4) : '0.0000'} SOL`);
  });
}

main().catch(error => {
  logMessage(`Error: ${error.message}`);
});