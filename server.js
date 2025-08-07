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

// Add this to your routes
function verifySignature(message, signature, publicKey) {
  try {
    // Convert string signature back to Uint8Array
    const signatureArray = new Uint8Array(signature.split(',').map(Number));
    
    // Reconstruct the signed message
    const tx = Transaction.populate(Message.from(Buffer.from(message)));
    tx.addSignature(new PublicKey(publicKey), signatureArray);
    
    return tx.verifySignatures();
  } catch (err) {
    console.error("Signature verification failed:", err);
    return false;
  }
}


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

async function getExistingProject(projectKey) {
  console.log("[PROJECT] Attempting to fetch existing project...");
  
  try {
    // Option 1: Verify project account exists
    if (projectKey) {
      const projectPubkey = new PublicKey(projectKey);
      const accountInfo = await connection.getAccountInfo(projectPubkey);
      
      if (accountInfo) {
        console.log(`[PROJECT] Found existing project: ${projectKey}`);
        return projectPubkey;
      }
      throw new Error("Project account not found");
    }

    // Option 2: Alternative lookup by authority (treasurer wallet)
    // Note: This would require knowing the project was created with this authority
    const projectAccounts = await connection.getProgramAccounts(
      new PublicKey("HoneycombProgramId"), // Replace with actual program ID
      {
        filters: [
          { dataSize: 165 }, // Standard project account size
          { 
            memcmp: {
              offset: 8, // Authority offset
              bytes: treasurerWallet.publicKey.toBase58()
            }
          }
        ]
      }
    );

    if (projectAccounts.length > 0) {
      const projectAddress = projectAccounts[0].pubkey;
      console.log(`[PROJECT] Found project by authority: ${projectAddress}`);
      return projectAddress;
    }

    throw new Error("No existing projects found");
    
  } catch (err) {
    console.error("[PROJECT] Fetch error:", err);
    throw err;
  }
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

// Temp session store (use Redis in production)
const activeSessions = new Map();

// Endpoint for React to register wallet
app.post('/link-wallet', async (req, res) => {
  const { sessionToken, walletAddress, signature } = req.body;
  
  // Verify wallet signature here (security critical!)
  const isValid = await verifySignature(walletAddress, signature);
  
  if (isValid) {
    activeSessions.set(sessionToken, { walletAddress });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid signature" });
  }
});

// Endpoint for Love2D to check session
app.get('/check-session', (req, res) => {
  console.log('[SESSION] Checking session for token:', req.query.token);
  console.log('[SESSION] Current sessions:', challengeStore.sessions);
  const session = challengeStore.sessions?.[req.query.token];// activeSessions.get(req.query.token);
  console.log("session found!", session);
  res.json(session || { error: "Not linked" });
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

// Add this near your other route handlers
app.post('/verify-session', async (req, res) => {
  console.log("[API] POST /verify-session request received:", req.body);
  const { sessionToken, walletAddress, signature } = req.body;
  
  try {
    // Verify the signature (pseudo-code - implement your actual verification)
    const message = `Verify wallet for game session: ${sessionToken}`;
    const verified = true; // Replace with actual signature verification
    
    if (verified) {
      console.log(`[SESSION] Verified wallet ${walletAddress} for session ${sessionToken}`);
      
      // Store the session (in-memory for now - use Redis in production)
      if (!challengeStore.sessions) challengeStore.sessions = {};
      challengeStore.sessions[sessionToken] = {
        walletAddress,
        verifiedAt: new Date().toISOString()
      };
      
      return res.json({ verified: true });
    }
    
    throw new Error('Invalid signature');
  } catch (err) {
    console.error("[API] /verify-session error:", err);
    res.status(400).json({ error: err.message });
  }
});

// === Honeycomb-Specific Routes ===

// Authentication Endpoint
app.post('/auth', async (req, res) => {
  const { wallet, project } = req.body;
  
  try {
    // Verify wallet owns project
    const { accessToken } = await honeycombClient.createAccessToken({
      wallet,
      project
    });
    
    res.json({ 
      access_token: accessToken,
      expires_in: 3600 // 1 hour
    });
  } catch (err) {
    console.error("[AUTH] Error:", err);
    res.status(401).json({ error: "Authentication failed" });
  }
});

// User Creation
app.post('/users', async (req, res) => {
  const { wallet, info, payer } = req.body;
  
  try {
    const { tx } = await honeycombClient.createNewUserTransaction({
      wallet,
      info: info || {},
      payer: payer || wallet
    });
    
    res.json({
      transaction: tx,
      status: "pending"
    });
  } catch (err) {
    console.error("[USER] Creation failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// Profile Management
app.post('/profiles', async (req, res) => {
  const { project, identity, info, payer } = req.body;
  const authHeader = req.headers.authorization;

  try {
    if (!authHeader) throw new Error("Authorization required");
    
    const { tx } = await honeycombClient.createNewProfileTransaction({
      project,
      identity: identity || "main",
      info: info || {},
      payer: payer || project
    }, {
      headers: { authorization: authHeader }
    });
    
    res.json({
      transaction: tx,
      status: "pending"
    });
  } catch (err) {
    console.error("[PROFILE] Creation failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// XP and Achievements
app.post('/xp', async (req, res) => {
  const { wallet, project, amount } = req.body;
  
  try {
    const profile = await honeycombClient.findProfiles({
      wallets: [wallet],
      projects: [project]
    }).then(({ profile }) => profile[0]);

    if (!profile) throw new Error("Profile not found");

    const { tx } = await honeycombClient.createUpdatePlatformDataTransaction({
      profile: profile.address,
      platformData: { addXp: parseInt(amount) || 0 },
      authority: treasurerWallet.publicKey.toString()
    });

    res.json({
      transaction: tx,
      xp_added: amount
    });
  } catch (err) {
    console.error("[XP] Error:", err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/achievements', async (req, res) => {
  const { wallet, project, achievement } = req.body;
  
  try {
    const profile = await honeycombClient.findProfiles({
      wallets: [wallet],
      projects: [project]
    }).then(({ profile }) => profile[0]);

    if (!profile) throw new Error("Profile not found");

    const { tx } = await honeycombClient.createUpdatePlatformDataTransaction({
      profile: profile.address,
      platformData: { 
        addAchievements: [achievement] 
      },
      authority: treasurerWallet.publicKey.toString()
    });

    res.json({
      transaction: tx,
      achievement_unlocked: achievement
    });
  } catch (err) {
    console.error("[ACHIEVEMENT] Error:", err);
    res.status(400).json({ error: err.message });
  }
});

// Custom Data Storage
app.post('/data', async (req, res) => {
  const { wallet, project, key, value, metadata } = req.body;
  
  try {
    const profile = await honeycombClient.findProfiles({
      wallets: [wallet],
      projects: [project]
    }).then(({ profile }) => profile[0]);

    if (!profile) throw new Error("Profile not found");

    const { tx } = await honeycombClient.createUpdateProfileTransaction({
      profile: profile.address,
      customData: {
        add: [[key, JSON.stringify(value)]]
      },
      payer: treasurerWallet.publicKey.toString()
    });

    res.json({
      transaction: tx,
      data_stored: { [key]: value }
    });
  } catch (err) {
    console.error("[DATA] Storage failed:", err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/data/:key', async (req, res) => {
  const { wallet, project } = req.query;
  const { key } = req.params;
  
  try {
    const profile = await honeycombClient.findProfiles({
      wallets: [wallet],
      projects: [project]
    }).then(({ profile }) => profile[0]);

    if (!profile) throw new Error("Profile not found");

    const value = profile.customData?.find(item => item.key === key)?.value;
    
    res.json({
      key,
      value: value ? JSON.parse(value) : null
    });
  } catch (err) {
    console.error("[DATA] Retrieval failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// === Enhanced Existing Routes ===

app.post('/progress', async (req, res) => {
  const { walletAddress, challengeId, progress, sessionToken } = req.body;
  
  try {
    // Session verification
    if (sessionToken) {
      const session = challengeStore.sessions?.[sessionToken];
      if (!session || session.walletAddress !== walletAddress) {
        throw new Error('Invalid session');
      }
    }
    
    // Local progress tracking
    if (!challengeStore.playerProgress[walletAddress]) {
      challengeStore.playerProgress[walletAddress] = {};
    }
    
    const playerProgress = challengeStore.playerProgress[walletAddress][challengeId] || {
      completed: 0,
      claimed: false
    };
    
    playerProgress.completed += progress;
    
    // On-chain XP reward
    if (honeycombProject) {
      await honeycombClient.createUpdatePlatformDataTransaction({
        profile: await getProfileAddress(walletAddress),
        platformData: { addXp: Math.floor(progress * 10) }, // 10 XP per progress point
        authority: treasurerWallet.publicKey.toString()
      });
    }
    
    res.json({ progress: playerProgress });
  } catch (err) {
    console.error("[PROGRESS] Error:", err);
    res.status(400).json({ error: err.message });
  }
});

// === Helper Functions ===
// Add to top with other stores
const profileCache = new Map();

// Modify getProfileAddress
async function getProfileAddress(wallet) {
  if (profileCache.has(wallet)) {
    return profileCache.get(wallet);
  }
  
  const { profile } = await honeycombClient.findProfiles({
    wallets: [wallet],
    projects: [honeycombProject]
  });
  
  if (profile[0]) {
    profileCache.set(wallet, profile[0].address);
  }
  
  return profile[0]?.address;
}

async function ensureProjectInitialized() {
  if (!honeycombProject) {
    try {
      honeycombProject = await getExistingProject(process.env.PROJECT_PUBKEY);
    } catch {
      console.log("No existing project found, creating new one");
      honeycombProject = await initializeProject();
      
      // Create profiles tree after project init
      await honeycombClient.createCreateProfilesTreeTransaction({
        payer: treasurerWallet.publicKey.toString(),
        project: honeycombProject.toString(),
        treeConfig: {
          basic: { numAssets: 100000 }
        }
      });
    }
  }
  return honeycombProject;
}

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

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
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
    honeycombProject = await ensureProjectInitialized();
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
