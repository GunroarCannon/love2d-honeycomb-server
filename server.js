// === ENV + SETUP ===
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createEdgeClient } = require('@honeycomb-protocol/edge-client');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');

const app = express();
const PORT = process.env.PORT || 3000;

// === ENHANCED CLIENT INITIALIZATION ===
let honeycombClient;

function initializeHoneycombClient() {
  try {
    const apiUrl = process.env.HONEYCOMB_API_URL || 'https://edge.main.honeycombprotocol.com/';
    console.log("Initializing Honeycomb client with URL:", apiUrl);
    
    honeycombClient = createEdgeClient(apiUrl, true);
    
    // Enhanced verification
    console.log("Honeycomb client verification:", {
      apiUrl: honeycombClient?.apiUrl || 'undefined',
      network: honeycombClient?.network || 'undefined', 
      connected: !!honeycombClient?.connection,
      clientExists: !!honeycombClient
    });
    
    if (!honeycombClient) {
      throw new Error("Failed to create Honeycomb client - client is null/undefined");
    }
    
    return honeycombClient;
    
  } catch (error) {
    console.error("❌ Honeycomb client initialization failed:", error);
    throw error;
  }
}

// Solana connection with better error handling
let connection;
try {
  connection = new Connection(
    process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
    'confirmed'
  );
  console.log("✅ Solana connection established:", connection.rpcEndpoint);
} catch (error) {
  console.error("❌ Solana connection failed:", error);
  process.exit(1);
}

// Treasury wallet with validation
let treasurerWallet;
try {
  if (!process.env.TREASURER_PRIVATE_KEY) {
    throw new Error("TREASURER_PRIVATE_KEY environment variable is required");
  }
  
  const privateKeyArray = JSON.parse(process.env.TREASURER_PRIVATE_KEY);
  if (!Array.isArray(privateKeyArray) || privateKeyArray.length !== 64) {
    throw new Error("TREASURER_PRIVATE_KEY must be a 64-element array");
  }
  
  treasurerWallet = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));
  console.log("✅ Treasury wallet loaded:", treasurerWallet.publicKey.toString());
} catch (error) {
  console.error("❌ Treasury wallet setup failed:", error);
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// === GAME STATE ===
const challengeStore = {
  currentDate: '',
  challenges: [],
  playerProgress: {}
};

// === HONEYCOMB PROJECT ===
let honeycombProject;

// Missing function implementation
async function getExistingProject() {
  try {
    console.log("Attempting to fetch existing project...");
    // This would need the actual project lookup logic based on your Honeycomb setup
    // For now, return null to force re-creation
    return null;
  } catch (error) {
    console.error("Failed to get existing project:", error);
    return null;
  }
}

async function initializeProject() {
  try {
    console.log("Initializing Honeycomb project...");
    
    // Initialize client first
    if (!honeycombClient) {
      honeycombClient = initializeHoneycombClient();
    }
    
    // Verify treasury wallet
    const balance = await connection.getBalance(treasurerWallet.publicKey);
    console.log("Treasury wallet verification:", {
      publicKey: treasurerWallet.publicKey.toString(),
      balance: balance / LAMPORTS_PER_SOL + " SOL"
    });
    
    if (balance === 0) {
      console.warn("⚠️ Treasury wallet has 0 SOL - transactions may fail");
    }

    // Check if Honeycomb client has required methods
    if (!honeycombClient.createCreateProjectTransaction) {
      throw new Error("Honeycomb client missing createCreateProjectTransaction method - check API version");
    }

    // Create project with error handling
    const projectConfig = {
      name: "DailyChallengesGame",
      authority: treasurerWallet.publicKey.toString(),
      payer: treasurerWallet.publicKey.toString(),
      profileDataConfig: {
        achievements: ["DailyWinner", "WeekStreak"],
        customDataFields: ["TotalPoints", "LastPlayed"]
      }
    };

    console.log("Creating project with config:", projectConfig);
    
    // Create transaction with timeout
    const createTxPromise = honeycombClient.createCreateProjectTransaction(projectConfig);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Transaction creation timeout")), 10000)
    );
    
    const { project, tx } = await Promise.race([createTxPromise, timeoutPromise]);
    
    if (!tx) {
      throw new Error("Transaction creation returned null - check Honeycomb client configuration and network connectivity");
    }

    // Get recent blockhash with retry logic
    let blockhash, lastValidBlockHeight;
    let retries = 3;
    
    while (retries > 0) {
      try {
        const result = await connection.getLatestBlockhash();
        blockhash = result.blockhash;
        lastValidBlockHeight = result.lastValidBlockHeight;
        break;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        console.log(`Retrying blockhash fetch... (${retries} left)`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Build and send transaction
    const transaction = new Transaction({
      feePayer: treasurerWallet.publicKey,
      recentBlockhash: blockhash,
    }).add(tx);

    console.log("Sending transaction...");
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [treasurerWallet],
      { 
        skipPreflight: false, // Enable preflight for better error info
        commitment: 'confirmed',
        maxRetries: 3
      }
    );

    honeycombProject = project;
    console.log("✅ Project created successfully!");
    console.log(`Project ID: ${project.toString()}`);
    console.log(`Transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    return project;
    
  } catch (err) {
    console.error("❌ Project initialization failed:", {
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 5).join('\n') // Truncate stack trace
    });
    
    // Handle specific errors
    if (err.message.includes("Project already exists")) {
      console.log("Project exists - fetching details...");
      honeycombProject = await getExistingProject();
      return honeycombProject;
    }
    
    if (err.message.includes("Transaction creation timeout")) {
      console.error("Honeycomb API is not responding - check network connectivity");
    }
    
    if (err.message.includes("insufficient funds")) {
      console.error("Treasury wallet needs more SOL for transaction fees");
    }
    
    throw err;
  }
}

// === GAME LOGIC ===
function generateDailyChallenges() {
  const verbs = ['Defeat', 'Collect', 'Complete'];
  const targets = ['enemies', 'coins', 'levels'];
  
  return Array.from({ length: 3 }, (_, i) => ({
    id: `daily_${Date.now()}_${i}`,
    verb: verbs[Math.floor(Math.random() * verbs.length)],
    target: targets[Math.floor(Math.random() * targets.length)],
    amount: Math.floor(Math.random() * 5) + 3,
    reward: (Math.floor(Math.random() * 5) + 3) * 10,
    badgeIndex: i
  }));
}

// === ROUTES ===
app.get('/challenges', async (req, res) => {
  try {
    const today = new Date().toDateString();
    
    if (challengeStore.currentDate !== today) {
      challengeStore.currentDate = today;
      challengeStore.challenges = generateDailyChallenges();
      challengeStore.playerProgress = {};
    }
    
    res.json(challengeStore.challenges);
  } catch (error) {
    console.error("Error in /challenges:", error);
    res.status(500).json({ error: "Failed to generate challenges" });
  }
});

app.post('/connect', async (req, res) => {
  const { walletAddress } = req.body;
  
  try {
    if (!walletAddress) {
      return res.status(400).json({ error: "Wallet address is required" });
    }

    const pubkey = new PublicKey(walletAddress);
    const accountInfo = await connection.getAccountInfo(pubkey);
    
    if (!accountInfo) {
      console.log(`Wallet ${walletAddress} not found on chain - may be new`);
    }
    
    res.json({
      wallet: walletAddress,
      challenges: challengeStore.challenges,
      progress: challengeStore.playerProgress[walletAddress] || {}
    });
  } catch (err) {
    console.error("Error in /connect:", err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/progress', async (req, res) => {
  const { walletAddress, challengeId, progress } = req.body;
  
  try {
    if (!walletAddress || !challengeId || progress === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const challenge = challengeStore.challenges.find(c => c.id === challengeId);
    if (!challenge) {
      return res.status(404).json({ error: 'Challenge not found' });
    }
    
    if (!challengeStore.playerProgress[walletAddress]) {
      challengeStore.playerProgress[walletAddress] = {};
    }
    
    const playerProgress = challengeStore.playerProgress[walletAddress][challengeId] || {
      completed: 0,
      claimed: false
    };
    
    playerProgress.completed = Math.min(playerProgress.completed + progress, challenge.amount);
    challengeStore.playerProgress[walletAddress][challengeId] = playerProgress;
    
    if (playerProgress.completed >= challenge.amount && !playerProgress.claimed) {
      console.log(`Player ${walletAddress} completed challenge ${challengeId}`);
      playerProgress.claimed = true;
    }
    
    res.json({ progress: playerProgress });
  } catch (err) {
    console.error("Error in /progress:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    honeycombProject: honeycombProject?.toString() || 'not initialized',
    challenges: challengeStore.challenges.length,
    timestamp: new Date().toISOString()
  });
});

// === GRACEFUL STARTUP ===
async function startServer() {
  try {
    console.log("🚀 Starting server initialization...");
    
    // Initialize Honeycomb client first
    initializeHoneycombClient();
    
    // Try to initialize project (non-blocking)
    try {
      await initializeProject();
    } catch (error) {
      console.error("⚠️ Project initialization failed, but server will continue:", error.message);
      // Server can still run for basic functionality
    }
    
    // Generate initial challenges
    challengeStore.challenges = generateDailyChallenges();
    
    // Start server
    app.listen(PORT, () => {
      console.log("✅ Server running successfully!");
      console.log(`🌐 URL: http://localhost:${PORT}`);
      console.log(`💰 Treasurer: ${treasurerWallet.publicKey.toString()}`);
      console.log(`🎯 Project: ${honeycombProject?.toString() || 'Not initialized'}`);
      console.log(`📊 Challenges: ${challengeStore.challenges.length} generated`);
    });
    
  } catch (error) {
    console.error("❌ Server startup failed:", error);
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server
startServer();
