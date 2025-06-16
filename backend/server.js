const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/downloads', express.static('generated'));
app.use('/templates', express.static('templates'));
app.use('/certificates', express.static('generated/certificates'));

// Create necessary folders
fs.ensureDirSync('uploads');
fs.ensureDirSync('templates');
fs.ensureDirSync('generated');
fs.ensureDirSync('generated/certificates');

// File upload configuration
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

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
  return nodemailer.createTransporter({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER || 'your-email@gmail.com',
      pass: process.env.EMAIL_PASS || 'your-app-password'
    }
  });
};

// Helper function to sanitize email for filename
const sanitizeEmailForFilename = (email) => {
  return email.replace(/[^a-zA-Z0-9@.-]/g, '_').replace(/\s+/g, '_');
};

// Helper function to find email column
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

// API: Upload Excel file
app.post('/upload-excel', upload.single('excel'), async (req, res) => {
  try {
    console.log('📁 Excel file uploaded:', req.file.originalname);
    
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get available templates
app.get('/templates', async (req, res) => {
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Save text positions
app.post('/save-positions', (req, res) => {
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Generate preview certificate (first row only)
app.post('/preview-certificate', async (req, res) => {
  let browser;
  try {
    const { filePath, templateId, columnMapping } = req.body;
    
    console.log(`🔍 Generating preview for ${templateId}...`);
    
    // Read Excel data (only first row)
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    
    if (data.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No data found in Excel file.' 
      });
    }
    
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
    
    // Launch Puppeteer for preview
    console.log('🤖 Launching browser for preview...');
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    } catch (puppeteerError) {
      console.error('Puppeteer launch error:', puppeteerError);
      return res.status(500).json({ 
        success: false, 
        error: 'Preview generation not available.' 
      });
    }
    
    // Read template image and convert to base64
    const templatePath = path.join(__dirname, 'templates', templateFile);
    const imageBuffer = fs.readFileSync(templatePath);
    const imageBase64 = imageBuffer.toString('base64');
    const imageUrl = `data:image/jpeg;base64,${imageBase64}`;
    
    // Use first row for preview
    const firstRow = data[0];
    
    // Map Excel data to template fields
    const mappedData = {};
    Object.keys(columnMapping).forEach(templateField => {
      const excelColumn = columnMapping[templateField];
      const value = firstRow[excelColumn];
      mappedData[templateField] = value ? String(value).substring(0, 100) : '';
    });
    
    console.log('📋 Preview data:', mappedData);
    
    // Create HTML for preview
    const previewHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { 
            margin: 0; 
            padding: 0; 
            font-family: 'Arial', sans-serif;
        }
        .certificate {
            position: relative;
            width: 1200px;
            height: 800px;
            background-image: url('${imageUrl}');
            background-size: 1200px 800px;
            background-repeat: no-repeat;
            background-position: center;
            overflow: hidden;
        }
        .text-field {
            position: absolute;
            color: #333;
            font-weight: bold;
            white-space: nowrap;
            transform-origin: center;
        }
        .text-center {
            text-align: center;
            transform: translateX(-50%);
        }
        .text-left {
            text-align: left;
        }
        .text-right {
            text-align: right;
            transform: translateX(-100%);
        }
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
          
          return `
            <div class="text-field text-${align}" style="
                left: ${x}px;
                top: ${y}px;
                font-size: ${pos.fontSize || 32}px;
            ">
                ${mappedData[field]}
            </div>
          `;
        }).join('')}
    </div>
</body>
</html>
    `;
    
    // Generate preview image
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.setContent(previewHTML, { waitUntil: 'networkidle0' });
    
    const timestamp = Date.now();
    const previewPath = `generated/preview_${timestamp}.png`;
    
    await page.screenshot({
      path: previewPath,
      type: 'png',
      clip: { x: 0, y: 0, width: 1200, height: 800 }
    });
    
    await page.close();
    await browser.close();
    
    console.log(`✅ Preview generated: ${previewPath}`);
    
    res.json({
      success: true,
      message: 'Preview generated successfully!',
      previewImage: previewPath,
      previewUrl: `/downloads/${path.basename(previewPath)}`,
      sampleData: mappedData,
      note: 'This preview shows how the first row of your Excel data will look on the certificate.'
    });
    
  } catch (error) {
    console.error('❌ Preview generation error:', error);
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
    res.status(500).json({ 
      success: false, 
      error: `Preview generation failed: ${error.message}` 
    });
  }
});

// Puppeteer configuration for Railway
const puppeteerConfig = {
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
  ],
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
};


// API: Generate certificates as individual images
app.post('/generate-certificates', async (req, res) => {
  let browser;
  try {
    const { filePath, templateId, columnMapping } = req.body;
    
    console.log(`🚀 Starting certificate image generation for ${templateId}...`);
    console.log('📋 Column mapping:', columnMapping);
    
    // Read Excel data
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
    
    console.log('🎯 Template config found:', templateConfig);
    
    // Find template file
    const templateFiles = fs.readdirSync('templates').filter(file => 
      file.match(/\.(jpg|jpeg|png|gif)$/i)
    );
    const templateIndex = parseInt(templateId.replace('template', '')) - 1;
    const templateFile = templateFiles[templateIndex];
    
    if (!templateFile) {
      return res.status(400).json({ success: false, error: 'Template image not found' });
    }
    
    console.log(`🖼️ Using template: ${templateFile}`);
    
    // Find email column
    const emailColumn = findEmailColumn(columnMapping, data);
    if (!emailColumn) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email column not found! Please include an email field in your Excel data and mapping.' 
      });
    }
    
    console.log(`📧 Email column found: ${emailColumn}`);
    
    // Launch Puppeteer
    console.log('🤖 Launching browser for image generation...');
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ]
      });
    } catch (puppeteerError) {
      console.error('Puppeteer launch error:', puppeteerError);
      return res.status(500).json({ 
        success: false, 
        error: 'Image generation not available.' 
      });
    }
    
    const timestamp = Date.now();
    
    // Read template image and convert to base64
    const templatePath = path.join(__dirname, 'templates', templateFile);
    let imageBase64;
    try {
      const imageBuffer = fs.readFileSync(templatePath);
      imageBase64 = imageBuffer.toString('base64');
    } catch (imageError) {
      console.error('Error reading template image:', imageError);
      return res.status(500).json({ 
        success: false, 
        error: 'Template image not found or corrupted' 
      });
    }
    
    const imageUrl = `data:image/jpeg;base64,${imageBase64}`;
    const generatedFiles = [];
    const certificateRecords = [];
    
    // Process each certificate individually
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      console.log(`📄 Processing certificate ${i + 1}/${data.length}`);
      
      // Map Excel data to template fields
      const mappedData = {};
      Object.keys(columnMapping).forEach(templateField => {
        const excelColumn = columnMapping[templateField];
        const value = row[excelColumn];
        mappedData[templateField] = value ? String(value).substring(0, 100) : '';
      });
      
      // Get email for filename
      const email = row[emailColumn];
      if (!email) {
        console.log(`⚠️ Skipping row ${i + 1}: No email found`);
        continue;
      }
      
      const sanitizedEmail = sanitizeEmailForFilename(email);
      const fileName = `${sanitizedEmail}_${timestamp}_${i + 1}.png`;
      const filePath = `generated/certificates/${fileName}`;
      
      // Create HTML for this certificate
      const certificateHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { 
            margin: 0; 
            padding: 0; 
            font-family: 'Arial', sans-serif;
        }
        .certificate {
            position: relative;
            width: 1200px;
            height: 800px;
            background-image: url('${imageUrl}');
            background-size: 1200px 800px;
            background-repeat: no-repeat;
            background-position: center;
            overflow: hidden;
        }
        .text-field {
            position: absolute;
            color: #333;
            font-weight: bold;
            white-space: nowrap;
            transform-origin: center;
        }
        .text-center {
            text-align: center;
            transform: translateX(-50%);
        }
        .text-left {
            text-align: left;
        }
        .text-right {
            text-align: right;
            transform: translateX(-100%);
        }
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
          
          return `
            <div class="text-field text-${align}" style="
                left: ${x}px;
                top: ${y}px;
                font-size: ${pos.fontSize || 32}px;
            ">
                ${mappedData[field]}
            </div>
          `;
        }).join('')}
    </div>
</body>
</html>
      `;
      
      // Create screenshot
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
      
      // Store certificate record for database
      const certificateRecord = {
        email: email,
        fileName: fileName,
        data: mappedData,
        generatedAt: new Date().toISOString(),
        templateId: templateId,
        templateFile: templateFile,
        certificateId: `${templateId}_${timestamp}_${i + 1}`,
        batchId: timestamp
      };
      
      certificateRecords.push(certificateRecord);
    }
    
    await browser.close();
    
    // Update certificate database
    certificateDatabase = certificateDatabase.concat(certificateRecords);
    saveDatabase();
    
    // Create summary
    const summaryPath = `generated/summary_${timestamp}.txt`;
    const summary = `
🎓 CERTIFICATE IMAGE GENERATION SUMMARY
======================================
Generated: ${new Date().toLocaleString()}
Template: ${templateFile}
Template ID: ${templateId}
Total Certificates: ${generatedFiles.length}
Email Column: ${emailColumn}

📁 GENERATED FILES:
${generatedFiles.map((file, i) => `${i + 1}. ${file}`).join('\n')}

📧 EMAIL ADDRESSES:
${certificateRecords.map((cert, i) => `${i + 1}. ${cert.email}`).join('\n')}

📍 FIELD POSITIONS:
${Object.keys(templateConfig.fields).map(field => 
  `${field}: X=${templateConfig.fields[field].x}%, Y=${templateConfig.fields[field].y}% (${templateConfig.fields[field].align || 'center'} aligned)`
).join('\n')}

✅ Image generation completed successfully!
🗃️ Certificate database updated with ${certificateRecords.length} records
    `;
    
    try {
      fs.writeFileSync(summaryPath, summary);
    } catch (summaryError) {
      console.error('Error writing summary:', summaryError);
    }
    
    console.log(`✅ Generated ${generatedFiles.length} certificate images!`);
    console.log(`📁 Images saved in: generated/certificates/`);
    
    res.json({
      success: true,
      message: `🎉 ${generatedFiles.length} certificate images generated successfully!`,
      files: {
        certificates: generatedFiles,
        summary: summaryPath,
        folder: 'generated/certificates/'
      },
      certificatesCount: generatedFiles.length,
      emailColumn: emailColumn,
      note: 'Each certificate saved as individual PNG file named by email address!'
    });
    
  } catch (error) {
    console.error('❌ Certificate generation error:', error);
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
    res.status(500).json({ 
      success: false, 
      error: `Certificate generation failed: ${error.message}` 
    });
  }
});

// API: Send bulk emails
app.post('/send-bulk-emails', async (req, res) => {
  try {
    const { emailConfig, subject, message } = req.body;
    
    console.log('📧 Starting bulk email sending...');
    
    if (certificateDatabase.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No certificates found! Generate certificates first.'
      });
    }
    
    const transporter = createEmailTransporter();
    const results = [];
    
    for (const cert of certificateDatabase) {
      try {
        const certPath = path.join(__dirname, 'generated/certificates', cert.fileName);
        
        if (!fs.existsSync(certPath)) {
          console.log(`⚠️ Certificate file not found: ${cert.fileName}`);
          continue;
        }
        
        const mailOptions = {
          from: emailConfig.from || process.env.EMAIL_USER,
          to: cert.email,
          subject: subject || 'Your Certificate',
          html: `
            <h2>Congratulations!</h2>
            <p>${message || 'Please find your certificate attached.'}</p>
            <p>Certificate Details:</p>
            <ul>
              ${Object.keys(cert.data).map(field => 
                `<li><strong>${field}:</strong> ${cert.data[field]}</li>`
              ).join('')}
            </ul>
            <p>Best regards!</p>
          `,
          attachments: [{
            filename: `certificate_${cert.email}.png`,
            path: certPath
          }]
        };
        
        await transporter.sendMail(mailOptions);
        results.push({ email: cert.email, status: 'sent' });
        console.log(`✅ Email sent to: ${cert.email}`);
        
      } catch (emailError) {
        console.error(`❌ Email failed for ${cert.email}:`, emailError);
        results.push({ email: cert.email, status: 'failed', error: emailError.message });
      }
    }
    
    res.json({
      success: true,
      message: `📧 Bulk email completed!`,
      results: results,
      sent: results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length
    });
    
  } catch (error) {
    console.error('❌ Bulk email error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Certificate portal - find all certificates by email
app.get('/portal/certificate/:email', (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    
    // Find ALL certificates for this email
    const certificates = certificateDatabase.filter(cert => 
      cert.email.toLowerCase() === email
    );
    
    if (certificates.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No certificates found for this email address.'
      });
    }
    
    // Check if certificate files exist and prepare response
    const validCertificates = [];
    
    for (const certificate of certificates) {
      const certPath = path.join(__dirname, 'generated/certificates', certificate.fileName);
      
      if (fs.existsSync(certPath)) {
        validCertificates.push({
          certificateId: certificate.certificateId || `cert_${validCertificates.length + 1}`,
          email: certificate.email,
          fileName: certificate.fileName,
          data: certificate.data,
          generatedAt: certificate.generatedAt,
          templateFile: certificate.templateFile,
          downloadUrl: `/certificates/${certificate.fileName}`,
          batchId: certificate.batchId
        });
      }
    }
    
    if (validCertificates.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Certificate files not found.'
      });
    }
    
    // Group certificates by batch/generation date for better organization
    const groupedCertificates = {};
    validCertificates.forEach(cert => {
      const date = new Date(cert.generatedAt).toDateString();
      if (!groupedCertificates[date]) {
        groupedCertificates[date] = [];
      }
      groupedCertificates[date].push(cert);
    });
    
    res.json({
      success: true,
      email: email,
      totalCertificates: validCertificates.length,
      certificates: validCertificates,
      groupedByDate: groupedCertificates
    });
    
  } catch (error) {
    console.error('❌ Portal error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Portal search page
app.get('/portal', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>🎓 Certificate Portal</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 900px; margin: 20px auto; padding: 20px; background: #f5f7fa; }
        .portal { background: white; padding: 30px; border-radius: 12px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        input { padding: 15px; width: 100%; margin: 10px 0; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; }
        button { padding: 15px 30px; background: #667eea; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; }
        button:hover { background: #764ba2; }
        .result { margin: 20px 0; text-align: left; }
        .error { color: red; background: #ffe6e6; padding: 15px; border-radius: 8px; }
        .success { color: green; }
        .certificate-group { 
            margin: 20px 0; 
            border: 2px solid #e0e6ed; 
            border-radius: 12px; 
            overflow: hidden;
            background: white;
        }
        .group-header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
            color: white; 
            padding: 15px 20px; 
            font-weight: bold; 
            font-size: 18px;
        }
        .certificate-item { 
            padding: 20px; 
            border-bottom: 1px solid #eee; 
            display: flex; 
            justify-content: space-between; 
            align-items: center;
        }
        .certificate-item:last-child { border-bottom: none; }
        .cert-info { flex: 1; }
        .cert-title { font-weight: bold; color: #333; margin-bottom: 5px; }
        .cert-details { color: #666; font-size: 14px; }
        .download-btn { 
            background: #4caf50; 
            color: white; 
            padding: 10px 20px; 
            text-decoration: none; 
            border-radius: 6px;
            font-weight: bold;
            transition: all 0.3s ease;
        }
        .download-btn:hover { 
            background: #45a049; 
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(76, 175, 80, 0.4);
        }
        .summary { 
            background: #e8f5e8; 
            padding: 15px; 
            border-radius: 8px; 
            margin: 20px 0;
            text-align: center;
        }
        .loading { text-align: center; color: #667eea; font-weight: bold; }
        .download-all-btn {
            background: #ff9800;
            color: white;
            padding: 12px 25px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            margin: 10px 5px;
            transition: all 0.3s ease;
        }
        .download-all-btn:hover {
            background: #f57c00;
            transform: translateY(-2px);
        }
    </style>
</head>
<body>
    <div class="portal">
        <h1>🎓 Certificate Portal</h1>
        <p>Enter your email address to find all your certificates</p>
        
        <input type="email" id="emailInput" placeholder="Enter your email address" />
        <br />
        <button onclick="searchCertificates()">🔍 Find My Certificates</button>
        
        <div id="result"></div>
    </div>
    
    <script>
        async function searchCertificates() {
            const email = document.getElementById('emailInput').value;
            const resultDiv = document.getElementById('result');
            
            if (!email) {
                resultDiv.innerHTML = '<div class="error">Please enter your email address</div>';
                return;
            }
            
            resultDiv.innerHTML = '<div class="loading">🔍 Searching for your certificates...</div>';
            
            try {
                const response = await fetch(\`/portal/certificate/\${email}\`);
                const data = await response.json();
                
                if (data.success) {
                    let html = \`
                        <div class="summary">
                            <h3>✅ Found \${data.totalCertificates} Certificate(s) for \${data.email}</h3>
                            <button class="download-all-btn" onclick="downloadAllCertificates()">
                                📥 Download All Certificates
                            </button>
                        </div>
                    \`;
                    
                    // Group certificates by date
                    Object.keys(data.groupedByDate).forEach(date => {
                        const certs = data.groupedByDate[date];
                        html += \`
                            <div class="certificate-group">
                                <div class="group-header">
                                    📅 Generated on \${date} (\${certs.length} certificate\${certs.length > 1 ? 's' : ''})
                                </div>
                        \`;
                        
                        certs.forEach((cert, index) => {
                            const certTitle = Object.values(cert.data).filter(val => val).join(' - ') || \`Certificate \${index + 1}\`;
                            html += \`
                                <div class="certificate-item">
                                    <div class="cert-info">
                                        <div class="cert-title">🏆 \${certTitle}</div>
                                        <div class="cert-details">
                                            Generated: \${new Date(cert.generatedAt).toLocaleString()}<br>
                                            Template: \${cert.templateFile}<br>
                                            File: \${cert.fileName}
                                        </div>
                                    </div>
                                    <a href="\${cert.downloadUrl}" download class="download-btn">
                                        📥 Download
                                    </a>
                                </div>
                            \`;
                        });
                        
                        html += '</div>';
                    });
                    
                    // Store certificates for download all functionality
                    window.userCertificates = data.certificates;
                    
                    resultDiv.innerHTML = html;
                } else {
                    resultDiv.innerHTML = \`<div class="error">❌ \${data.error}</div>\`;
                }
            } catch (error) {
                resultDiv.innerHTML = '<div class="error">❌ Error searching for certificates. Please try again.</div>';
                console.error('Search error:', error);
            }
        }
        
        async function downloadAllCertificates() {
            if (!window.userCertificates || window.userCertificates.length === 0) {
                alert('No certificates to download');
                return;
            }
            
            for (let i = 0; i < window.userCertificates.length; i++) {
                const cert = window.userCertificates[i];
                
                // Create download link and trigger download
                const link = document.createElement('a');
                link.href = cert.downloadUrl;
                link.download = cert.fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                
                // Small delay between downloads to avoid browser blocking
                if (i < window.userCertificates.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
            alert(\`📥 Started downloading \${window.userCertificates.length} certificates!\`);
        }
        
        document.getElementById('emailInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                searchCertificates();
            }
        });
    </script>
</body>
</html>
  `);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    server: 'Certificate Generator with Images + Email/Portal',
    templates: fs.readdirSync('templates').length,
    certificates: certificateDatabase.length
  });
});

app.listen(PORT, () => {
  console.log(`🍎 Server running on http://localhost:${PORT}`);
  console.log(`📁 Put your template images in the "templates" folder`);
  console.log(`🎯 Individual certificate images enabled!`);
  console.log(`📧 Bulk email system ready!`);
  console.log(`🌐 Certificate portal: http://localhost:${PORT}/portal`);
  
  try {
    const templates = fs.readdirSync('templates').filter(file => 
      file.match(/\.(jpg|jpeg|png|gif)$/i)
    );
    console.log(`🎨 Found ${templates.length} template(s):`, templates);
  } catch (error) {
    console.log('📁 Creating templates folder...');
    fs.ensureDirSync('templates');
  }
});