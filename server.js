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

// Initialize Honeycomb client
const honeycombClient = createEdgeClient(
  process.env.HONEYCOMB_API_URL || 'https://edge.main.honeycombprotocol.com/',
  true // enable logging
);

// Solana connection
const connection = new Connection(
  process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
  'confirmed'
);

// Treasury wallet (using JSON array from ENV)
const treasurerWallet = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(process.env.TREASURER_PRIVATE_KEY))
);

app.use(cors());
app.use(express.json());

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
    console.log("Treasurer PublicKey:", treasurerWallet.publicKey.toString());
    
    // 1. Create project transaction
    const { project, tx: createTx } = await honeycombClient.createCreateProjectTransaction({
      name: "DailyChallengesGame",
      authority: treasurerWallet.publicKey,
      profileDataConfig: {
        achievements: ["DailyWinner", "WeekStreak"],
        customDataFields: ["TotalPoints", "LastPlayed"]
      }
    });

    // 2. Add recent blockhash (critical fix)
    const { blockhash } = await connection.getLatestBlockhash();
    createTx.recentBlockhash = blockhash;
    createTx.feePayer = treasurerWallet.publicKey;

    // 3. Sign and send
    console.log("Sending transaction...");
    const signature = await sendAndConfirmTransaction(
      connection,
      createTx,
      [treasurerWallet],
      { commitment: 'confirmed' }
    );

    honeycombProject = project;
    console.log("✅ Project Created:", {
      projectId: project.toString(),
      txSignature: signature,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    });
    
  } catch (err) {
    console.error("❌ Project initialization failed:", {
      error: err.message,
      stack: err.stack
    });
    
    // Special handling for existing projects
    if (err.message.includes("Project already exists")) {
      console.log("⚠️ Project exists - fetching details...");
      honeycombProject = await getExistingProject();
      return;
    }
    throw err; // Re-throw other errors
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
