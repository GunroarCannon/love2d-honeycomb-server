// === ENV + SETUP ===
require('dotenv').config();
console.log("[INIT] Environment variables loaded");

const express = require('express');
const cors = require('cors');
const { createEdgeClient } = require('@honeycomb-protocol/edge-client');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');

console.log("[INIT] Dependencies loaded");

const app = express();
const PORT = process.env.PORT || 3000;
console.log(`[CONFIG] Server port set to: ${PORT}`);

// Network configuration
const HONEYCOMB_NETWORKS = {
  mainnet: 'https://edge.main.honeycombprotocol.com',
  testnet: 'https://edge.test.honeycombprotocol.com',
  solanaDevnet: 'https://api.devnet.solana.com'
};
console.log("[CONFIG] Network endpoints configured");

// Initialize connections with debug logs
console.log("[NETWORK] Initializing Solana connection...");
const connection = new Connection(
  'https://rpc.test.honeycombprotocol.com', // process.env.SOLANA_RPC || HONEYCOMB_NETWORKS.testnet,
  'confirmed'
);
console.log(`[NETWORK] Solana RPC connected to: ${connection.rpcEndpoint}`);

console.log("[NETWORK] Initializing Honeycomb client...");
const SOLANA_RPC = "https://rpc.test.honeycombprotocol.com/";
const HONEYCOMB_API = "https://edge.test.honeycombprotocol.com/";


// Correct Honeycomb client initialization (ONLY the API URL is passed here)
const honeycombClient = createEdgeClient(HONEYCOMB_API, true);

// Log details

/*{
  apiUrl: process.env.HONEYCOMB_API_URL || 'https://edge.main.honeycombprotocol.com/',
  connection: connection,
  network: 'testnet',
  debug: true
});
*/
// Verify client initialization
console.log("[DEBUG] Honeycomb client verification:", {
  apiUrl: honeycombClient.apiUrl,
  network: honeycombClient.network,
  connectionValid: !!honeycombClient.connection,
  connectionEndpoint: honeycombClient.connection?.rpcEndpoint
});

// Treasury wallet setup with validation
console.log("[WALLET] Initializing treasurer wallet...");
let treasurerWallet;
try {
  treasurerWallet = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(process.env.TREASURER_PRIVATE_KEY))
  );
  console.log("[WALLET] Treasurer wallet initialized successfully:", {
    publicKey: treasurerWallet.publicKey.toString(),
    isSigner: true // Assuming valid keypair
  });
} catch (err) {
  console.error("[ERROR] Failed to initialize treasurer wallet:", {
    error: err.message,
    stack: err.stack,
    envKeyFormat: typeof process.env.TREASURER_PRIVATE_KEY
  });
  process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());
console.log("[SERVER] Middleware initialized");

// === GAME STATE ===
const challengeStore = {
  currentDate: '',
  challenges: [],
  playerProgress: {}
};
console.log("[GAME] Initialized empty challenge store");

// === HONEYCOMB PROJECT ===
let honeycombProject;
async function initializeProject() {
  console.log("[PROJECT] Starting project initialization...");
  
  try {
    // Verify treasury wallet balance
    console.log("[BALANCE] Checking treasurer wallet balance...");
    const balance = await connection.getBalance(treasurerWallet.publicKey);
    const balanceSOL = balance / LAMPORTS_PER_SOL;
    console.log(`[BALANCE] Current balance: ${balanceSOL} SOL`);
    
    if (balanceSOL < 0.1) {
      throw new Error(`Insufficient funds (${balanceSOL} SOL). Need at least 0.1 SOL for transactions`);
    }

    // Project configuration
    const projectConfig = {
      name: "DailyChallengesGame",
      authority: treasurerWallet.publicKey.toString(),
      payer: treasurerWallet.publicKey.toString(),
      profileDataConfig: {
        achievements: ["DailyWinner", "WeekStreak"],
        customDataFields: ["TotalPoints", "LastPlayed"]
      }
    };
    console.log("[PROJECT] Creating project with config:", JSON.stringify(projectConfig, null, 2));

    // Create transaction
    console.log("[TX] Creating project transaction...");
    //const { project, tx, error } = await honeycombClient.createCreateProjectTransaction(projectConfig);
    const result = await honeycombClient.createCreateProjectTransaction(projectConfig);

    if (!result || result.error || !result.tx) {
      console.error("[ERROR] Project creation failed:", result?.error ?? "Unknown error");
      return;
    }
    const error=null;
    const { project, tx } = result;
  
    if (error) {
      console.error("[TX] Transaction creation error details:", error);
      throw new Error(`Transaction creation failed: ${error.message}`);
    }
    
    if (!tx) {
      throw new Error("Transaction object is undefined");
    }
    console.log("[TX] Transaction created successfully");

    // Prepare transaction
    console.log("[TX] Getting recent blockhash...");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    console.log(`[TX] Blockhash: ${blockhash}, Valid until: ${lastValidBlockHeight}`);

    const transaction = new Transaction({
      feePayer: treasurerWallet.publicKey,
      recentBlockhash: blockhash,
    }).add(tx);
    console.log("[TX] Transaction built successfully");

    // Send transaction
    console.log("[TX] Sending transaction...");
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [treasurerWallet],
      { 
        skipPreflight: true,
        commitment: 'confirmed',
        minContextSlot: lastValidBlockHeight - 150 // Add buffer
      }
    );
    
    console.log(`[TX] Transaction confirmed: ${signature}`);
    console.log(`[TX] Explorer URL: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    honeycombProject = project;
    console.log(`[PROJECT] Project created successfully! ID: ${project.toString()}`);
    return project;
    
  } catch (err) {
    console.error("[ERROR] Project initialization failed:", {
      error: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString()
    });
    
    if (err.message.includes("Project already exists")) {
      console.log("[PROJECT] Project exists - attempting to fetch...");
      try {
        honeycombProject = await getExistingProject();
        return honeycombProject;
      } catch (fetchErr) {
        console.error("[ERROR] Failed to fetch existing project:", fetchErr);
        throw fetchErr;
      }
    }
    
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
    await initializeProject();
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
