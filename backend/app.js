require("dotenv").config()
const express = require("express")
const cors = require("cors")
const { Pool } = require("pg")
const crypto = require("crypto")
const multer = require("multer")
const path = require("path")
const fs = require("fs")

const app = express()
const port = process.env.PORT || 5000

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads")
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/")
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9)
    cb(null, "candidate-" + uniqueSuffix + path.extname(file.originalname))
  },
})

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true)
    } else {
      cb(new Error("Only PDF files are allowed!"), false)
    }
  },
})

// Middleware
app.use(cors())
app.use(express.json())
app.use("/uploads", express.static("uploads"))
app.use(cors({
  origin: "*", // Allow all origins for development
}));

// PostgreSQL setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
})

// Create tables if not exist
const initializeDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        subject VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        company VARCHAR(100),
        project_name VARCHAR(200) NOT NULL,
        project_id VARCHAR(50) UNIQUE NOT NULL,
        zorvixe_id VARCHAR(50) UNIQUE NOT NULL,
        payment_amount NUMERIC(10, 2) NOT NULL,
        project_description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_links (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        token VARCHAR(100) UNIQUE NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        payment_completed BOOLEAN DEFAULT FALSE,
        reference_id VARCHAR(50)
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_registrations (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id),
        client_name VARCHAR(100) NOT NULL,
        project_name VARCHAR(100) NOT NULL,
        project_id VARCHAR(50) NOT NULL,
        zorvixe_id VARCHAR(50) NOT NULL,
        amount NUMERIC(10, 2) NOT NULL,
        due_date DATE NOT NULL,
        receipt_url TEXT NOT NULL,
        reference_id VARCHAR(50) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        project_description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_links (
        id SERIAL PRIMARY KEY,
        token VARCHAR(100) UNIQUE NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Candidates table - PDFs stored permanently
    await pool.query(`
      CREATE TABLE IF NOT EXISTS candidates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        position VARCHAR(100),
        candidate_id VARCHAR(50) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Candidate links table - only links expire, not the PDFs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS candidate_links (
        id SERIAL PRIMARY KEY,
        candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
        token VARCHAR(100) UNIQUE NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        upload_completed BOOLEAN DEFAULT FALSE
      )
    `)

    // Candidate uploads table - PDFs persist permanently
    await pool.query(`
      CREATE TABLE IF NOT EXISTS candidate_uploads (
        id SERIAL PRIMARY KEY,
        candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_path TEXT NOT NULL,
        file_size BIGINT NOT NULL,
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) DEFAULT 'uploaded'
      )
    `)

    // Insert the fixed token if not exists
    await pool.query(`
      INSERT INTO payment_links (token)
      VALUES ('4vXcZpLmKjQ8aTyNfRbEoWg7HdUs29qT')
      ON CONFLICT (token) DO NOTHING
    `)

    console.log("Database initialized")
  } catch (err) {
    console.error("Database initialization error:", err)
  }
}

initializeDb()

// Generate unique IDs
const generateProjectId = () => {
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.random().toString(36).substr(2, 4).toUpperCase()
  return `PRJ-${timestamp}-${random}`
}

const generateZorvixeId = () => {
  const random = Math.random().toString(36).substr(2, 6).toUpperCase()
  return `ZOR-${random}`
}

const generateCandidateId = () => {
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.random().toString(36).substr(2, 4).toUpperCase()
  return `CAN-${timestamp}-${random}`
}

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" })
})

// Contact form submission
app.post("/api/contact/submit", async (req, res) => {
  const { name, email, phone, subject, message } = req.body

  const errors = {}
  if (!name || name.trim().length < 3) errors.name = "Name must be at least 3 characters"
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Valid email is required"
  if (!phone || !/^[6-9]\d{9}$/.test(phone)) errors.phone = "Valid 10-digit phone number starting with 6-9 is required"
  if (!subject) errors.subject = "Please select a service"
  if (!message || message.trim().length < 10) errors.message = "Message must be at least 10 characters"

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors })
  }

  try {
    const result = await pool.query(
      `INSERT INTO contacts (name, email, phone, subject, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, email, phone, subject, message],
    )

    res.status(201).json({
      success: true,
      message: "Form submitted successfully",
      data: result.rows[0],
    })
  } catch (error) {
    console.error("Database error:", error)
    res.status(500).json({
      success: false,
      message: "Failed to submit form",
      error: error.message,
    })
  }
})

// Get all contact submissions
app.get("/api/contacts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM contacts 
      ORDER BY created_at DESC
    `)

    const contacts = result.rows.map((contact) => ({
      ...contact,
      created_at: new Date(contact.created_at).toLocaleString(),
    }))

    res.status(200).json(contacts)
  } catch (error) {
    console.error("Error fetching contacts:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch contacts",
      error: error.message,
    })
  }
})

// CLIENT MANAGEMENT ROUTES
app.post("/api/admin/clients", async (req, res) => {
  const { name, email, phone, company, projectName, paymentAmount, projectDescription } = req.body

  try {
    const projectId = generateProjectId()
    const zorvixeId = generateZorvixeId()

    const result = await pool.query(
      `INSERT INTO clients (name, email, phone, company, project_name, project_id, zorvixe_id, payment_amount, project_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [name, email, phone, company, projectName, projectId, zorvixeId, paymentAmount, projectDescription],
    )

    res.status(201).json({
      success: true,
      client: result.rows[0],
    })
  } catch (error) {
    console.error("Error creating client:", error)
    res.status(500).json({ success: false, message: "Failed to create client" })
  }
})

// Get all clients
app.get("/api/admin/clients", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*,
             cl.token AS active_token,
             cl.expires_at AS token_expiry,
             cl.active AS token_active,
             cl.payment_completed,
             cl.reference_id
      FROM clients c
      LEFT JOIN client_links cl ON c.id = cl.client_id 
        AND cl.expires_at > NOW() 
       AND cl.active = true
      ORDER BY c.created_at DESC
    `)

    res.status(200).json({ success: true, clients: result.rows })
  } catch (error) {
    console.error("Error fetching clients:", error)
    res.status(500).json({ success: false, message: "Failed to fetch clients" })
  }
})

// Generate payment link for client
app.post("/api/admin/client-links", async (req, res) => {
  const { clientId } = req.body

  try {
    const clientResult = await pool.query(`SELECT * FROM clients WHERE id = $1`, [clientId])

    if (clientResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Client not found" })
    }

    const client = clientResult.rows[0]
    const token = crypto.randomBytes(32).toString("hex")
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 30)

    await pool.query(`UPDATE client_links SET active = false WHERE client_id = $1`, [clientId])

    const result = await pool.query(
      `INSERT INTO client_links (client_id, token, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [clientId, token, expiresAt],
    )

    const paymentUrl = `https://zorvixetechnologies.onrender.com/payment/${token}`

    res.status(201).json({
      success: true,
      link: paymentUrl,
      token,
      expiresAt,
      client: client,
    })
  } catch (error) {
    console.error("Error generating link:", error)
    res.status(500).json({ success: false, message: "Failed to generate link" })
  }
})

// CANDIDATE MANAGEMENT ROUTES
// Create new candidate
app.post("/api/admin/candidates", async (req, res) => {
  const { name, email, phone, position } = req.body

  // Validation
  const errors = {}
  if (!name || name.trim().length < 3) errors.name = "Name must be at least 3 characters"
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Valid email is required"
  if (!phone || !/^[6-9]\d{9}$/.test(phone)) errors.phone = "Valid 10-digit phone number starting with 6-9 is required"
  if (!position || position.trim().length < 2) errors.position = "Position must be at least 2 characters"

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, errors })
  }

  try {
    const candidateId = generateCandidateId()

    const result = await pool.query(
      `INSERT INTO candidates (name, email, phone, position, candidate_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, email, phone, position, candidateId],
    )

    res.status(201).json({
      success: true,
      candidate: result.rows[0],
    })
  } catch (error) {
    console.error("Error creating candidate:", error)
    if (error.code === "23505") {
      // Unique violation
      res.status(400).json({ success: false, message: "Email already exists" })
    } else {
      res.status(500).json({ success: false, message: "Failed to create candidate" })
    }
  }
})

// Get all candidates
app.get("/api/admin/candidates", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*,
             cl.token AS active_token,
             cl.expires_at AS token_expiry,
             cl.active AS token_active,
             cl.upload_completed,
             cu.file_name,
             cu.file_size,
             cu.upload_date
      FROM candidates c
      LEFT JOIN candidate_links cl ON c.id = cl.candidate_id 
        AND cl.expires_at > NOW() 
        AND cl.active = true
      LEFT JOIN candidate_uploads cu ON c.id = cu.candidate_id
      ORDER BY c.created_at DESC
    `)

    res.status(200).json({ success: true, candidates: result.rows })
  } catch (error) {
    console.error("Error fetching candidates:", error)
    res.status(500).json({ success: false, message: "Failed to fetch candidates" })
  }
})

// Generate onboarding link for candidate (link expires, not PDF)
app.post("/api/admin/candidate-links", async (req, res) => {
  const { candidateId } = req.body

  try {
    const candidateResult = await pool.query(`SELECT * FROM candidates WHERE id = $1`, [candidateId])

    if (candidateResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Candidate not found" })
    }

    const candidate = candidateResult.rows[0]
    const token = crypto.randomBytes(32).toString("hex")
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + 5) // Link expires in 5 hours (changed from 2 hours)

    // Deactivate any existing links for this candidate
    await pool.query(`UPDATE candidate_links SET active = false WHERE candidate_id = $1`, [candidateId])

    const result = await pool.query(
      `INSERT INTO candidate_links (candidate_id, token, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [candidateId, token, expiresAt],
    )

    const onboardingUrl = `https://zorvixetechnologies.onrender.com/onboarding/${token}`

    res.status(201).json({
      success: true,
      link: onboardingUrl,
      token,
      expiresAt,
      candidate: candidate,
    })
  } catch (error) {
    console.error("Error generating onboarding link:", error)
    res.status(500).json({ success: false, message: "Failed to generate onboarding link" })
  }
})

// Activate/Deactivate candidate onboarding link
app.put("/api/admin/candidate-links/:candidateId/toggle", async (req, res) => {
  const { candidateId } = req.params
  const { active } = req.body

  try {
    const result = await pool.query(
      `UPDATE candidate_links 
       SET active = $1 
       WHERE candidate_id = $2 AND expires_at > NOW()
       RETURNING *`,
      [active, candidateId],
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No active link found for this candidate",
      })
    }

    res.status(200).json({
      success: true,
      message: `Link ${active ? "activated" : "deactivated"}`,
      link: result.rows[0],
    })
  } catch (error) {
    console.error("Error toggling candidate link:", error)
    res.status(500).json({
      success: false,
      message: "Failed to toggle link status",
    })
  }
})

// Get candidate details by token (check if link is valid, not PDF)
app.get("/api/candidate-details/:token", async (req, res) => {
  const { token } = req.params

  try {
    const linkResult = await pool.query(
      `SELECT * FROM candidate_links 
       WHERE token = $1 
         AND active = true 
         AND expires_at > NOW()`,
      [token],
    )

    if (linkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Link not found, expired, or inactive",
      })
    }

    const link = linkResult.rows[0]
    const candidateResult = await pool.query(`SELECT * FROM candidates WHERE id = $1`, [link.candidate_id])

    if (candidateResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found",
      })
    }

    const candidate = candidateResult.rows[0]

    // Check if already uploaded (PDF persists even if link expires)
    const uploadResult = await pool.query(`SELECT * FROM candidate_uploads WHERE candidate_id = $1`, [candidate.id])

    res.status(200).json({
      success: true,
      candidate: {
        ...candidate,
        hasUploaded: uploadResult.rows.length > 0,
        uploadDetails: uploadResult.rows[0] || null,
      },
      linkId: link.id,
    })
  } catch (error) {
    console.error("Error fetching candidate details:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch candidate details",
    })
  }
})

// Upload candidate PDF (PDF stored permanently, only link expires)
app.post("/api/candidate/upload/:token", upload.single("certificate"), async (req, res) => {
  const { token } = req.params

  try {
    // Verify token (only link expires, not the ability to access uploaded PDFs)
    const linkResult = await pool.query(
      `SELECT cl.*, c.* FROM candidate_links cl
       JOIN candidates c ON cl.candidate_id = c.id
       WHERE cl.token = $1 
         AND cl.active = true 
         AND cl.expires_at > NOW()`,
      [token],
    )

    if (linkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invalid or expired link",
      })
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
      })
    }

    const link = linkResult.rows[0]
    const candidate = linkResult.rows[0]

    // Check if already uploaded
    const existingUpload = await pool.query(`SELECT * FROM candidate_uploads WHERE candidate_id = $1`, [candidate.id])

    if (existingUpload.rows.length > 0) {
      // Delete the uploaded file since candidate already has a file
      fs.unlinkSync(req.file.path)
      return res.status(400).json({
        success: false,
        message: "Certificate already uploaded for this candidate",
      })
    }

    // Save upload details (PDF stored permanently)
    const uploadResult = await pool.query(
      `INSERT INTO candidate_uploads (candidate_id, file_name, file_path, file_size)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [candidate.id, req.file.originalname, req.file.path, req.file.size],
    )

    // Mark link as completed (link can expire, but PDF remains)
    await pool.query(`UPDATE candidate_links SET upload_completed = true WHERE id = $1`, [link.id])

    // Update candidate status
    await pool.query(`UPDATE candidates SET status = 'documents_uploaded' WHERE id = $1`, [candidate.id])

    res.status(201).json({
      success: true,
      message: "Certificate uploaded successfully. The file will be stored permanently.",
      upload: uploadResult.rows[0],
    })
  } catch (error) {
    console.error("Error uploading file:", error)
    // Clean up uploaded file on error
    if (req.file) {
      fs.unlinkSync(req.file.path)
    }
    res.status(500).json({
      success: false,
      message: "Failed to upload certificate",
      error: error.message,
    })
  }
})

// Download candidate PDF (admin only - PDFs never expire)
app.get("/api/admin/candidate-download/:candidateId", async (req, res) => {
  const { candidateId } = req.params

  try {
    const uploadResult = await pool.query(
      `SELECT cu.*, c.name as candidate_name 
       FROM candidate_uploads cu
       JOIN candidates c ON cu.candidate_id = c.id
       WHERE cu.candidate_id = $1`,
      [candidateId],
    )

    if (uploadResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No uploaded file found for this candidate",
      })
    }

    const upload = uploadResult.rows[0]
    const filePath = path.resolve(upload.file_path)

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "File not found on server",
      })
    }

    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `attachment; filename="${upload.candidate_name}-certificates.pdf"`)

    const fileStream = fs.createReadStream(filePath)
    fileStream.pipe(res)
  } catch (error) {
    console.error("Error downloading file:", error)
    res.status(500).json({
      success: false,
      message: "Failed to download file",
    })
  }
})

// Update candidate status
app.put("/api/admin/candidates/:id/status", async (req, res) => {
  const { id } = req.params
  const { status } = req.body

  const validStatuses = ["pending", "documents_uploaded", "approved", "rejected"]

  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid status value",
    })
  }

  try {
    const result = await pool.query(`UPDATE candidates SET status = $1 WHERE id = $2 RETURNING *`, [status, id])

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found",
      })
    }

    res.status(200).json({
      success: true,
      message: "Candidate status updated",
      candidate: result.rows[0],
    })
  } catch (error) {
    console.error("Error updating candidate status:", error)
    res.status(500).json({
      success: false,
      message: "Failed to update candidate status",
    })
  }
})

// CLIENT PAYMENT ROUTES
app.put("/api/admin/client-links/:clientId/toggle", async (req, res) => {
  const { clientId } = req.params
  const { active } = req.body

  try {
    const result = await pool.query(
      `UPDATE client_links 
       SET active = $1 
       WHERE client_id = $2 AND expires_at > NOW()
       RETURNING *`,
      [active, clientId],
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No active link found for this client",
      })
    }

    res.status(200).json({
      success: true,
      message: `Link ${active ? "activated" : "deactivated"}`,
      link: result.rows[0],
    })
  } catch (error) {
    console.error("Error toggling link:", error)
    res.status(500).json({
      success: false,
      message: "Failed to toggle link status",
    })
  }
})

app.get("/api/client-details/:token", async (req, res) => {
  const { token } = req.params

  try {
    const linkResult = await pool.query(
      `SELECT * FROM client_links 
       WHERE token = $1 
         AND active = true 
         AND expires_at > NOW()`,
      [token],
    )

    if (linkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Link not found, expired, or inactive",
      })
    }

    const link = linkResult.rows[0]
    const clientResult = await pool.query(`SELECT * FROM clients WHERE id = $1`, [link.client_id])

    if (clientResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      })
    }

    const client = clientResult.rows[0]
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 7)

    res.status(200).json({
      success: true,
      client: {
        ...client,
        clientName: client.name,
        clientId: client.id,
        projectName: client.project_name,
        projectId: client.project_id,
        zorvixeId: client.zorvixe_id,
        amount: client.payment_amount,
        dueDate: dueDate,
        projectDescription: client.project_description,
      },
      linkId: link.id,
    })
  } catch (error) {
    console.error("Error fetching client details:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch client details",
    })
  }
})

app.post("/api/payment/submit", async (req, res) => {
  const {
    clientId,
    clientName,
    projectName,
    projectId,
    zorvixeId,
    amount,
    dueDate,
    receiptUrl,
    projectDescription,
    linkId,
  } = req.body

  const year = new Date().getFullYear()
  const randomString = Math.random().toString(36).substr(2, 6).toUpperCase()
  const referenceId = `PAY-${year}-${randomString}`

  try {
    const result = await pool.query(
      `INSERT INTO payment_registrations 
       (client_id, client_name, project_name, project_id, zorvixe_id, amount, due_date, receipt_url, reference_id, project_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        clientId,
        clientName,
        projectName,
        projectId,
        zorvixeId,
        amount,
        dueDate,
        receiptUrl,
        referenceId,
        projectDescription,
      ],
    )

    if (linkId) {
      await pool.query(
        `UPDATE client_links 
         SET active = false, payment_completed = true, reference_id = $1 
         WHERE id = $2`,
        [referenceId, linkId],
      )
    }

    res.status(201).json({
      success: true,
      message: "Payment registration submitted successfully",
      referenceId,
      data: result.rows[0],
    })
  } catch (error) {
    console.error("Database error:", error)
    res.status(500).json({
      success: false,
      message: "Failed to submit payment registration",
      error: error.message,
    })
  }
})

app.get("/api/admin/payments", async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query
    const offset = (page - 1) * limit

    let query = `
      SELECT pr.*, c.email as client_email, c.phone as client_phone,
             COUNT(*) OVER() AS total_count 
      FROM payment_registrations pr
      LEFT JOIN clients c ON pr.client_id = c.id
    `

    const params = []
    const conditions = []

    if (status && status !== "all") {
      conditions.push(`pr.status = $${params.length + 1}`)
      params.push(status)
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`
    }

    query += `
      ORDER BY pr.created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `

    params.push(limit, offset)

    const result = await pool.query(query, params)
    const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0
    const totalPages = Math.ceil(total / limit)

    res.status(200).json({
      success: true,
      payments: result.rows.map((row) => {
        const { total_count, ...payment } = row
        return payment
      }),
      pagination: {
        total,
        totalPages,
        currentPage: Number(page),
        limit: Number(limit),
      },
    })
  } catch (error) {
    console.error("Error fetching payments:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch payment registrations",
      error: error.message,
    })
  }
})

app.get("/api/admin/payments/:id", async (req, res) => {
  try {
    const { id } = req.params
    const result = await pool.query(
      `SELECT pr.*, c.email as client_email, c.phone as client_phone, c.company 
       FROM payment_registrations pr
       LEFT JOIN clients c ON pr.client_id = c.id
       WHERE pr.id = $1`,
      [id],
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment registration not found",
      })
    }

    res.status(200).json({
      success: true,
      payment: result.rows[0],
    })
  } catch (error) {
    console.error("Error fetching payment:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch payment registration",
      error: error.message,
    })
  }
})

app.put("/api/admin/payments/:id/status", async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body

    if (!["pending", "verified", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value",
      })
    }

    const result = await pool.query(
      `UPDATE payment_registrations 
       SET status = $1 
       WHERE id = $2
       RETURNING *`,
      [status, id],
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment registration not found",
      })
    }

    res.status(200).json({
      success: true,
      message: "Payment status updated",
      payment: result.rows[0],
    })
  } catch (error) {
    console.error("Error updating payment status:", error)
    res.status(500).json({
      success: false,
      message: "Failed to update payment status",
      error: error.message,
    })
  }
})

app.get("/api/admin/payments/search", async (req, res) => {
  try {
    const { query } = req.query

    if (!query || query.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: "Search query must be at least 3 characters",
      })
    }

    const searchTerm = `%${query}%`
    const result = await pool.query(
      `SELECT pr.*, c.email as client_email, c.phone as client_phone 
       FROM payment_registrations pr
       LEFT JOIN clients c ON pr.client_id = c.id
       WHERE pr.client_name ILIKE $1 
          OR pr.project_name ILIKE $1 
          OR pr.project_id ILIKE $1 
          OR pr.zorvixe_id ILIKE $1
         OR pr.reference_id ILIKE $1
       ORDER BY pr.created_at DESC
       LIMIT 20`,
      [searchTerm],
    )

    res.status(200).json({
      success: true,
      payments: result.rows,
    })
  } catch (error) {
    console.error("Error searching payments:", error)
    res.status(500).json({
      success: false,
      message: "Failed to search payment registrations",
      error: error.message,
    })
  }
})

app.get("/api/payment-link/:token", async (req, res) => {
  const { token } = req.params

  try {
    const result = await pool.query(`SELECT * FROM payment_links WHERE token = $1`, [token])

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment link not found",
      })
    }

    res.status(200).json({
      success: true,
      active: true,
    })
  } catch (error) {
    console.error("Error fetching link status:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch link status",
    })
  }
})

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`)
})
