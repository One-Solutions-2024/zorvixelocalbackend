

// Create tables if not exists
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
    `);
    }}

initializeDb();

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});




// Contact form submission
app.post('/api/contact/submit', async (req, res) => {
  const { name, email, phone, subject, message } = req.body;

  const errors = {};

  if (!name || name.trim().length < 3) errors.name = 'Name must be at least 3 characters';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Valid email is required';
  if (!phone || !/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Valid 10-digit phone number starting with 6-9 is required';
  if (!subject) errors.subject = 'Please select a service';
  if (!message || message.trim().length < 10) errors.message = 'Message must be at least 10 characters';

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors });
  }

  try {
    const result = await pool.query(
      `INSERT INTO contacts (name, email, phone, subject, message) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [name, email, phone, subject, message]
    );

    res.status(201).json({
      success: true,
      message: 'Form submitted successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit form',
      error: error.message
    });
  }
});

// Get all contact submissions (add this after the POST endpoint)
app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM contacts 
      ORDER BY created_at DESC
    `);

    // Format dates for better readability
    const contacts = result.rows.map(contact => ({
      ...contact,
      created_at: new Date(contact.created_at).toLocaleString()
    }));

    res.status(200).json(contacts);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch contacts',
      error: error.message
    });
  }
});




