const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const walletsDir = path.join(__dirname, 'wallets');

// Create the wallets directory if it doesn't exist
if (!fs.existsSync(walletsDir)) {
  fs.mkdirSync(walletsDir);
}

function createWallet() {
  const keypair = Keypair.generate();
  const secretKey = bs58.encode(keypair.secretKey);
  const publicKey = keypair.publicKey.toBase58();
  const walletData = {
    publicKey,
    secretKey
  };

  const walletFile = path.join(walletsDir, `${publicKey}.json`);
  fs.writeFileSync(walletFile, JSON.stringify(walletData, null, 2));

  console.log(`New wallet created: ${publicKey}`);
  console.log(`Wallet details saved to ${walletFile}`);
}

createWallet();
