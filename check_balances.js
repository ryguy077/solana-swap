const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');

const walletsDir = path.join(__dirname, 'wallets');
const tempWalletsDir = path.join(walletsDir, 'temp');
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

async function getWalletBalance(publicKey) {
  const balance = await connection.getBalance(new PublicKey(publicKey));
  return balance / 1e9; // Convert lamports to SOL
}

async function checkBalances() {
  const walletFiles = fs.readdirSync(walletsDir).filter(file => file.endsWith('.json'));
  const tempWalletFiles = fs.existsSync(tempWalletsDir)
    ? fs.readdirSync(tempWalletsDir).filter(file => file.endsWith('.json'))
    : [];

  if (walletFiles.length === 0 && tempWalletFiles.length === 0) {
    console.error('No wallets found.');
    return;
  }

  console.log('Main Wallet Balances:');
  for (const walletFile of walletFiles) {
    const walletPath = path.join(walletsDir, walletFile);
    const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const publicKey = walletData.publicKey;
    const balance = await getWalletBalance(publicKey);
    console.log(`Wallet: ${publicKey}, Balance: ${balance.toFixed(4)} SOL`);
  }

  if (tempWalletFiles.length > 0) {
    console.log('\nTemporary Wallet Balances:');
    for (const walletFile of tempWalletFiles) {
      const walletPath = path.join(tempWalletsDir, walletFile);
      const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
      const publicKey = walletData.publicKey;
      const balance = await getWalletBalance(publicKey);
      console.log(`Wallet: ${publicKey}, Balance: ${balance.toFixed(4)} SOL`);
    }
  }
}

checkBalances();
