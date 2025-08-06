// === ENV + SETUP ===
require('dotenv').config();
console.log("[INIT] .env loaded");

// Dependencies
const express = require('express');
const cors = require('cors');
const { createEdgeClient } = require('@honeycomb-protocol/edge-client');
const {
  Connection, Keypair, PublicKey,
  Transaction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');

console.log("[INIT] Loaded dependencies", { edgeClient: !!createEdgeClient });

// App setup
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// Initialize challenge store
const challengeStore = {
  currentDate: new Date().toDateString(),
  challenges: [],
  playerProgress: {}
};

// Initialize Solana connection
const connection = new Connection(
  process.env.SOLANA_RPC || 'https://rpc.test.honeycombprotocol.com',
  'confirmed'
);
console.log(`[NETWORK] Connected to Solana RPC: ${connection.rpcEndpoint}`);

// Initialize Honeycomb client with debug
const honeycombClient = createEdgeClient(
  process.env.HONEYCOMB_API_URL || 'https://edge.test.honeycombprotocol.com',
  true
);
console.log("[HONEYCOMB] Client initialized:", {
  apiUrl: honeycombClient.apiUrl,
  network: honeycombClient.network
});

// Treasurer wallet
let treasurerWallet;
try {
  treasurerWallet = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(process.env.TREASURER_PRIVATE_KEY))
  );
  console.log("[WALLET] Treasurer initialized:", treasurerWallet.publicKey.toBase58());
} catch (err) {
  console.error("[WALLET] Invalid private key:", err);
  process.exit(1);
}

// === Helper: Strict check ===
function assertTx(result, label = '') {
  if (!result || !result.tx) {
    console.error(`[ASSERT] Missing tx in result${label || ''}`, result);
    throw new Error(`Missing tx in Honeycomb response${label}`);
  }
  return result;
}

// === Initialize Project ===
let honeycombProject;
async function initializeProject() {
  console.log("[PROJECT] Starting initialization...");
  
  try {
    // 1. Check balance
    const balance = await connection.getBalance(treasurerWallet.publicKey);
    console.log(`[PROJECT] Treasurer balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    // 2. Prepare project config
    const projectConfig = {
      name: `DailyGame_${Date.now()}`,
      authority: treasurerWallet.publicKey.toString(),
      payer: treasurerWallet.publicKey.toString(),
      subsidizeFees: true // Recommended for testnet
    };
    console.log("[PROJECT] Config:", JSON.stringify(projectConfig, null, 2));

    // 3. Create project transaction
    const response = await honeycombClient.createCreateProjectTransaction(projectConfig);
    
    if (!response?.createCreateProjectTransaction?.tx) {
      throw new Error("Invalid Honeycomb response - missing transaction data");
    }

    const { project: projectAddress, tx } = response.createCreateProjectTransaction;

    // 4. Build and send transaction
    const transaction = new Transaction({
      ...tx,
      feePayer: treasurerWallet.publicKey
    });

    console.log("[TX] Sending transaction...");
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [treasurerWallet],
      { 
        skipPreflight: true,
        commitment: 'confirmed'
      }
    );

    console.log(`✅ Project created!`);
    console.log(`- Address: ${projectAddress}`);
    console.log(`- TX: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    return projectAddress;

  } catch (err) {
    console.error("[FATAL] Project initialization failed:", err);
    throw err;
  }
}

async function getExistingProject() {
  console.log("[PROJECT] Attempting to fetch existing project...");
  // Implement your project fetching logic here
  throw new Error("getExistingProject not implemented");
}

// === GAME LOGIC ===
function generateDailyChallenges() {
  console.log("[GAME] Generating new daily challenges...");
  const verbs = ['Defeat', 'Collect', 'Complete'];
  const targets = ['enemies', 'coins', 'levels'];
  
  const challenges = Array.from({ length: 3 }, (_, i) => ({
    id: `daily_${Date.now()}_${i}`,
    verb: verbs[Math.floor(Math.random() * verbs.length)],
    target: targets[Math.floor(Math.random() * targets.length)],
    amount: Math.floor(Math.random() * 5) + 3,
    reward: (Math.floor(Math.random() * 5) + 3) * 10,
    badgeIndex: i
  }));
  
  console.log("[GAME] Generated challenges:", challenges);
  return challenges;
}

// === ROUTES ===
app.get('/challenges', async (req, res) => {
  console.log("[API] GET /challenges request received");
  const today = new Date().toDateString();
  
  if (challengeStore.currentDate !== today) {
    console.log("[GAME] New day detected - resetting challenges");
    challengeStore.currentDate = today;
    challengeStore.challenges = generateDailyChallenges();
    challengeStore.playerProgress = {};
  }
  
  res.json(challengeStore.challenges);
});

app.post('/connect', async (req, res) => {
  console.log("[API] POST /connect request received:", req.body);
  const { walletAddress } = req.body;
  
  try {
    console.log(`[WALLET] Validating wallet: ${walletAddress}`);
    const pubkey = new PublicKey(walletAddress);
    const accountInfo = await connection.getAccountInfo(pubkey);
    
    if (!accountInfo) {
      console.log(`[WALLET] Wallet not found: ${walletAddress}`);
      throw new Error('Wallet not found');
    }
    
    console.log(`[WALLET] Wallet validated: ${walletAddress}`);
    res.json({
      wallet: walletAddress,
      challenges: challengeStore.challenges,
      progress: challengeStore.playerProgress[walletAddress] || {}
    });
  } catch (err) {
    console.error("[API] /connect error:", err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/progress', async (req, res) => {
  console.log("[API] POST /progress request received:", req.body);
  const { walletAddress, challengeId, progress } = req.body;
  
  try {
    console.log(`[GAME] Updating progress for ${walletAddress} on challenge ${challengeId}`);
    const challenge = challengeStore.challenges.find(c => c.id === challengeId);
    
    if (!challenge) {
      console.log(`[GAME] Challenge not found: ${challengeId}`);
      throw new Error('Challenge not found');
    }
    
    if (!challengeStore.playerProgress[walletAddress]) {
      console.log(`[GAME] Initializing progress for new player: ${walletAddress}`);
      challengeStore.playerProgress[walletAddress] = {};
    }
    
    const playerProgress = challengeStore.playerProgress[walletAddress][challengeId] || {
      completed: 0,
      claimed: false
    };
    
    playerProgress.completed += progress;
    console.log(`[GAME] Updated progress:`, playerProgress);
    
    if (playerProgress.completed >= challenge.amount && !playerProgress.claimed) {
      console.log(`[GAME] Challenge completed! ${challengeId}`);
      playerProgress.claimed = true;
      // Add reward logic here
    }
    
    res.json({ progress: playerProgress });
  } catch (err) {
    console.error("[API] /progress error:", err);
    res.status(400).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  console.log("[API] Health check requested");
  try {
    const balance = await connection.getBalance(treasurerWallet.publicKey);
    const health = {
      status: 'OK',
      treasurerBalance: `${balance / LAMPORTS_PER_SOL} SOL`,
      projectInitialized: !!honeycombProject,
      lastChallengeReset: challengeStore.currentDate,
      timestamp: new Date().toISOString()
    };
    console.log("[HEALTH] System health:", health);
    res.json(health);
  } catch (err) {
    console.error("[HEALTH] Error:", err);
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// === START SERVER ===
app.listen(PORT, async () => {
  console.log(`[SERVER] Starting initialization on port ${PORT}...`);
  console.log(`[ENV] Current environment:`, {
    NODE_ENV: process.env.NODE_ENV,
    SOLANA_RPC: process.env.SOLANA_RPC,
    HONEYCOMB_API_URL: process.env.HONEYCOMB_API_URL
  });
  
  try {
    honeycombProject = await initializeProject();
    challengeStore.challenges = generateDailyChallenges();
    
    console.log(`[SERVER] Ready!`);
    console.log(`[INFO] Treasurer: ${treasurerWallet.publicKey.toString()}`);
    console.log(`[INFO] Project: ${honeycombProject?.toString() || 'Not created'}`);
    console.log(`[INFO] Explorer: https://explorer.solana.com/address/${treasurerWallet.publicKey.toString()}?cluster=devnet`);
  } catch (err) {
    console.error("[FATAL] Failed to initialize server:", err);
    process.exit(1);
  }
});
