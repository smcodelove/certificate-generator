require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // Disable for Puppeteer
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// Middleware
app.use(express.json({ limit: process.env.MAX_FILE_SIZE || '10mb' }));
app.use(express.urlencoded({ limit: process.env.MAX_FILE_SIZE || '10mb', extended: true }));

// Static file serving
app.use('/downloads', express.static('generated'));
app.use('/templates', express.static('templates'));
app.use('/certificates', express.static('generated/certificates'));

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/build')));
}

// Create necessary folders
fs.ensureDirSync('uploads');
fs.ensureDirSync('templates');
fs.ensureDirSync('generated');
fs.ensureDirSync('generated/certificates');

// File upload configuration with limits
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${timestamp}-${sanitized}`);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed!'), false);
    }
  }
});

// Template configurations
let templateConfigs = {};
let certificateDatabase = [];

// Load saved configurations
const configPath = 'template-configs.json';
if (fs.existsSync(configPath)) {
  try {
    templateConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.log('🍎 No saved configs found, using defaults');
  }
}

// Load certificate database
const dbPath = 'certificate-database.json';
if (fs.existsSync(dbPath)) {
  try {
    certificateDatabase = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (error) {
    console.log('📊 No certificate database found');
  }
}

const saveConfigs = () => {
  try {
    fs.writeFileSync(configPath, JSON.stringify(templateConfigs, null, 2));
  } catch (error) {
    console.error('Error saving configs:', error);
  }
};

const saveDatabase = () => {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(certificateDatabase, null, 2));
  } catch (error) {
    console.error('Error saving database:', error);
  }
};

// Email configuration
const createEmailTransporter = () => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('⚠️ Email not configured - set EMAIL_USER and EMAIL_PASS');
    return null;
  }
  
  return nodemailer.createTransporter({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
};

// API Routes (add /api prefix for production)
app.post('/api/upload-excel', upload.single('excel'), async (req, res) => {
  try {
    console.log('📁 Excel file uploaded:', req.file.originalname);
    
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    
    // Limit number of certificates
    const maxCertificates = parseInt(process.env.MAX_CERTIFICATES) || 1000;
    if (data.length > maxCertificates) {
      return res.status(400).json({
        success: false,
        error: `Too many rows! Maximum ${maxCertificates} certificates allowed.`
      });
    }
    
    const columns = Object.keys(data[0] || {});
    
    console.log(`📊 Found ${data.length} rows and ${columns.length} columns`);
    
    res.json({
      success: true,
      data: data.slice(0, 5),
      columns: columns,
      totalRows: data.length,
      filePath: req.file.path
    });
  } catch (error) {
    console.error('❌ Excel upload error:', error);
    res.status(500).json({ success: false, error: 'Failed to process Excel file' });
  }
});

app.get('/api/templates', async (req, res) => {
  try {
    console.log('🔍 Checking templates folder...');
    
    const templateFiles = fs.readdirSync('templates').filter(file => 
      file.match(/\.(jpg|jpeg|png|gif)$/i)
    );
    
    console.log('🎨 Found template files:', templateFiles);
    
    const templates = {};
    
    for (let i = 0; i < templateFiles.length; i++) {
      const file = templateFiles[i];
      const templateId = `template${i + 1}`;
      
      try {
        const imagePath = path.join('templates', file);
        const stats = fs.statSync(imagePath);
        
        if (stats.size > 0) {
          console.log(`✅ Template ${templateId}: ${file} (${stats.size} bytes)`);
          
          templates[templateId] = {
            name: file.replace(/\.[^/.]+$/, ""),
            image: file,
            width: 1200,
            height: 800,
            fields: templateConfigs[templateId]?.fields || {}
          };
        }
      } catch (error) {
        console.log(`⚠️ Error reading template ${file}:`, error.message);
      }
    }
    
    console.log('📋 Final templates loaded:', Object.keys(templates));
    
    res.json({
      success: true,
      templates: templates,
      count: Object.keys(templates).length
    });
    
  } catch (error) {
    console.error('❌ Templates load error:', error);
    res.status(500).json({ success: false, error: 'Failed to load templates' });
  }
});

app.post('/api/save-positions', (req, res) => {
  try {
    const { templateId, fields } = req.body;
    
    if (!templateConfigs[templateId]) {
      templateConfigs[templateId] = {};
    }
    
    templateConfigs[templateId].fields = fields;
    saveConfigs();
    
    console.log(`💾 Saved positions for ${templateId}:`, fields);
    
    res.json({ success: true, message: 'Positions saved successfully' });
  } catch (error) {
    console.error('❌ Save positions error:', error);
    res.status(500).json({ success: false, error: 'Failed to save positions' });
  }
});

// Certificate generation with better error handling
app.post('/api/generate-certificates', async (req, res) => {
  let browser;
  try {
    const { filePath, templateId, columnMapping } = req.body;
    
    console.log(`🚀 Starting certificate generation for ${templateId}...`);
    
    // Read and validate Excel data
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    
    // Check template configuration
    const templateConfig = templateConfigs[templateId];
    if (!templateConfig || !templateConfig.fields) {
      return res.status(400).json({ 
        success: false, 
        error: 'Template positions not set! Please use the visual editor first.' 
      });
    }
    
    // Find template file
    const templateFiles = fs.readdirSync('templates').filter(file => 
      file.match(/\.(jpg|jpeg|png|gif)$/i)
    );
    const templateIndex = parseInt(templateId.replace('template', '')) - 1;
    const templateFile = templateFiles[templateIndex];
    
    if (!templateFile) {
      return res.status(400).json({ success: false, error: 'Template image not found' });
    }
    
    // Find email column
    const findEmailColumn = (columnMapping, data) => {
      for (const [templateField, excelColumn] of Object.entries(columnMapping)) {
        if (templateField.toLowerCase().includes('email') || 
            excelColumn.toLowerCase().includes('email')) {
          return excelColumn;
        }
      }
      
      const firstRow = data[0] || {};
      for (const column of Object.keys(firstRow)) {
        if (column.toLowerCase().includes('email')) {
          return column;
        }
      }
      return null;
    };
    
    const emailColumn = findEmailColumn(columnMapping, data);
    if (!emailColumn) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email column not found! Please include an email field.' 
      });
    }
    
    // Launch Puppeteer with production settings
    console.log('🤖 Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });
    
    const timestamp = Date.now();
    const templatePath = path.join(__dirname, 'templates', templateFile);
    const imageBuffer = fs.readFileSync(templatePath);
    const imageBase64 = imageBuffer.toString('base64');
    const imageUrl = `data:image/jpeg;base64,${imageBase64}`;
    
    const generatedFiles = [];
    const certificateRecords = [];
    
    // Process certificates with progress tracking
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      console.log(`📄 Processing ${i + 1}/${data.length}`);
      
      const mappedData = {};
      Object.keys(columnMapping).forEach(templateField => {
        const excelColumn = columnMapping[templateField];
        const value = row[excelColumn];
        mappedData[templateField] = value ? String(value).substring(0, 100) : '';
      });
      
      const email = row[emailColumn];
      if (!email) continue;
      
      const sanitizedEmail = email.replace(/[^a-zA-Z0-9@.-]/g, '_');
      const fileName = `${sanitizedEmail}.png`;
      const filePath = `generated/certificates/${fileName}`;
      
      // Create certificate HTML
      const certificateHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
        .certificate {
            position: relative; width: 1200px; height: 800px;
            background-image: url('${imageUrl}');
            background-size: 1200px 800px; background-repeat: no-repeat;
        }
        .text-field { position: absolute; color: #333; font-weight: bold; white-space: nowrap; }
        .text-center { text-align: center; transform: translateX(-50%); }
        .text-left { text-align: left; }
        .text-right { text-align: right; transform: translateX(-100%); }
    </style>
</head>
<body>
    <div class="certificate">
        ${Object.keys(mappedData).map(field => {
          const pos = templateConfig.fields[field];
          if (!pos || !mappedData[field]) return '';
          
          const x = (pos.x / 100) * 1200;
          const y = (pos.y / 100) * 800;
          const align = pos.align || 'center';
          
          return `<div class="text-field text-${align}" style="left: ${x}px; top: ${y}px; font-size: ${pos.fontSize || 32}px;">${mappedData[field]}</div>`;
        }).join('')}
    </div>
</body>
</html>`;
      
      // Generate screenshot
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 800 });
      await page.setContent(certificateHTML, { waitUntil: 'networkidle0' });
      await page.screenshot({
        path: filePath,
        type: 'png',
        clip: { x: 0, y: 0, width: 1200, height: 800 }
      });
      await page.close();
      
      generatedFiles.push(fileName);
      certificateRecords.push({
        email: email,
        fileName: fileName,
        data: mappedData,
        generatedAt: new Date().toISOString(),
        templateId: templateId
      });
    }
    
    await browser.close();
    
    // Update database
    certificateDatabase = certificateDatabase.concat(certificateRecords);
    saveDatabase();
    
    console.log(`✅ Generated ${generatedFiles.length} certificates!`);
    
    res.json({
      success: true,
      message: `🎉 ${generatedFiles.length} certificates generated!`,
      certificatesCount: generatedFiles.length,
      files: generatedFiles
    });
    
  } catch (error) {
    console.error('❌ Generation error:', error);
    if (browser) await browser.close();
    res.status(500).json({ 
      success: false, 
      error: 'Certificate generation failed' 
    });
  }
});

// Portal and email APIs...
app.get('/api/portal/certificate/:email', (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const certificate = certificateDatabase.find(cert => 
      cert.email.toLowerCase() === email
    );
    
    if (!certificate) {
      return res.status(404).json({
        success: false,
        error: 'Certificate not found'
      });
    }
    
    res.json({
      success: true,
      certificate: {
        email: certificate.email,
        fileName: certificate.fileName,
        data: certificate.data,
        generatedAt: certificate.generatedAt,
        downloadUrl: `/certificates/${certificate.fileName}`
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Portal page
app.get('/portal', (req, res) => {
  const portalHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>🎓 Certificate Portal</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
        .portal { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; }
        input { padding: 15px; width: 100%; margin: 10px 0; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; }
        button { padding: 15px 30px; background: #667eea; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; }
        button:hover { background: #764ba2; }
        .result { margin: 20px 0; padding: 20px; background: #f8f9ff; border-radius: 8px; }
        .error { color: red; } .success { color: green; }
        .download-btn { display: inline-block; padding: 12px 24px; background: #4caf50; color: white; text-decoration: none; border-radius: 6px; margin: 10px 0; }
    </style>
</head>
<body>
    <div class="portal">
        <h1>🎓 Certificate Portal</h1>
        <p>Enter your email address to find and download your certificate</p>
        <input type="email" id="emailInput" placeholder="Enter your email address" />
        <br />
        <button onclick="searchCertificate()">🔍 Find My Certificate</button>
        <div id="result"></div>
    </div>
    
    <script>
        async function searchCertificate() {
            const email = document.getElementById('emailInput').value;
            const resultDiv = document.getElementById('result');
            
            if (!email) {
                resultDiv.innerHTML = '<div class="error">Please enter your email address</div>';
                return;
            }
            
            try {
                const response = await fetch(\`/api/portal/certificate/\${email}\`);
                const data = await response.json();
                
                if (data.success) {
                    resultDiv.innerHTML = \`
                        <div class="result success">
                            <h3>✅ Certificate Found!</h3>
                            <p><strong>Email:</strong> \${data.certificate.email}</p>
                            <p><strong>Generated:</strong> \${new Date(data.certificate.generatedAt).toLocaleString()}</p>
                            <a href="\${data.certificate.downloadUrl}" class="download-btn" download>📥 Download Certificate</a>
                        </div>
                    \`;
                } else {
                    resultDiv.innerHTML = \`<div class="error">❌ \${data.error}</div>\`;
                }
            } catch (error) {
                resultDiv.innerHTML = '<div class="error">❌ Error searching for certificate</div>';
            }
        }
        
        document.getElementById('emailInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') searchCertificate();
        });
    </script>
</body>
</html>`;
  
  res.send(portalHTML);
});

// Serve frontend for all other routes in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
  });
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
  console.log(`📧 Email configured: ${!!process.env.EMAIL_USER}`);
  console.log(`🎯 Ready for production!`);
});