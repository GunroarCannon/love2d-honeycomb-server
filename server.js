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

const {
  HONEYCOMB_API_URL,
  SOLANA_RPC,
  TREASURER_PRIVATE_KEY 
} = process.env;

// Network configuration (ADD THIS)
const HONEYCOMB_NETWORKS = {
  mainnet: 'https://rpc.main.honeycombprotocol.com',
  testnet: 'https://rpc.test.honeycombprotocol.com',
  // Optional: Add Solana clusters if needed
  solanaDevnet: 'https://api.devnet.solana.com'
};

// Initialize connection (MODIFY THIS)
const connection = new Connection(
  SOLANA_RPC || HONEYCOMB_NETWORKS.testnet, // Falls back to Honeycomb testnet
  'confirmed'
);

// Initialize Honeycomb client (MODIFY THIS)
const honeycombClient = createEdgeClient(
  HONEYCOMB_API_URL || 'https://edge.main.honeycombprotocol.com/',
  {
    connection, // Pass the Solana connection
    network: HONEYCOMB_NETWORKS.testnet, // Explicitly set network
    debug: true
  }
);
// Verify Honeycomb client is properly initialized
console.log("Honeycomb client verification:", {
  apiUrl: honeycombClient.apiUrl,
  network: honeycombClient.network,
  connected: !!honeycombClient.connection
});


// Treasury wallet (using JSON array from ENV)
const treasurerWallet = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(process.env.TREASURER_PRIVATE_KEY))
);

app.use(cors());
app.use(express.json());

console.log("Treasurer balance:", 
  await connection.getBalance(treasurerWallet.publicKey) / LAMPORTS_PER_SOL
);

// === GAME STATE ===
const challengeStore = {
  currentDate: '',
  challenges: [],
  playerProgress: {}
};

console.log("Environment Verification:", {
  rpcEndpoint: connection.rpcEndpoint,
  honeycombUrl: process.env.HONEYCOMB_API_URL,
  treasurerPubkey: treasurerWallet.publicKey.toString(),
  privateKeyFormat: Array.isArray(JSON.parse(process.env.TREASURER_PRIVATE_KEY))
});

// === HONEYCOMB PROJECT ===
let honeycombProject; // Will store our project ID
async function initializeProject() {
  try {
    console.log("Initializing Honeycomb project...");
    
// Verify treasury wallet
console.log("Treasury wallet verification:", {
  publicKey: treasurerWallet.publicKey.toString(),
  isSigner: await treasurerWallet.publicKey.isSigner,
  balance: await connection.getBalance(treasurerWallet.publicKey) / LAMPORTS_PER_SOL + " SOL"
});
    // 1. Verify Honeycomb client connection
  //  const honeycombStatus = await honeycombClient.getHealth();
    //console.log("Honeycomb client status:", honeycombStatus);

    // 2. Create project with explicit parameters
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
    
    // 3. Create and prepare transaction
    const { project, tx } = await honeycombClient.createCreateProjectTransaction(projectConfig);
    
    if (!tx) {
      throw new Error("Transaction creation failed - check Honeycomb client configuration");
    }

    // 4. Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    
    // 5. Build complete transaction
    const transaction = new Transaction({
      feePayer: treasurerWallet.publicKey,
      recentBlockhash: blockhash,
    }).add(tx);

    // 6. Sign and send
    console.log("Sending transaction...");
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [treasurerWallet],
      { skipPreflight: true, commitment: 'confirmed' }
    );

    honeycombProject = project;
    console.log("✅ Project created successfully!");
    console.log(`Project ID: ${project.toString()}`);
    console.log(`Transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    return project;
    
  } catch (err) {
    console.error("❌ Project initialization failed:", {
      error: err.message,
      stack: err.stack
    });
    
    if (err.message.includes("Project already exists")) {
      console.log("Project exists - fetching details...");
      honeycombProject = await getExistingProject();
      return honeycombProject;
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
  const today = new Date().toDateString();
  
  if (challengeStore.currentDate !== today) {
    challengeStore.currentDate = today;
    challengeStore.challenges = generateDailyChallenges();
    challengeStore.playerProgress = {};
  }
  
  res.json(challengeStore.challenges);
});

app.post('/connect', async (req, res) => {
  const { walletAddress } = req.body;
  
  try {
    const pubkey = new PublicKey(walletAddress);
    const accountInfo = await connection.getAccountInfo(pubkey);
    if (!accountInfo) throw new Error('Wallet not found');
    
    res.json({
      wallet: walletAddress,
      challenges: challengeStore.challenges,
      progress: challengeStore.playerProgress[walletAddress] || {}
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/progress', async (req, res) => {
  const { walletAddress, challengeId, progress } = req.body;
  
  try {
    const challenge = challengeStore.challenges.find(c => c.id === challengeId);
    if (!challenge) throw new Error('Challenge not found');
    
    if (!challengeStore.playerProgress[walletAddress]) {
      challengeStore.playerProgress[walletAddress] = {};
    }
    
    const playerProgress = challengeStore.playerProgress[walletAddress][challengeId] || {
      completed: 0,
      claimed: false
    };
    
    playerProgress.completed += progress;
    
    if (playerProgress.completed >= challenge.amount && !playerProgress.claimed) {
      // Reward logic here
      playerProgress.claimed = true;
    }
    
    res.json({ progress: playerProgress });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// === START SERVER ===
app.listen(PORT, async () => {
  console.log(`Initializing server...`);
  
  await initializeProject();
  challengeStore.challenges = generateDailyChallenges();
  
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Treasurer: ${treasurerWallet.publicKey.toString()}`);
  console.log(`Project: ${honeycombProject?.toString() || 'Not created'}`);
});
