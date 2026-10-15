const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve file statis dari folder yang sama dengan server.js
app.use(express.static(__dirname));

// Halaman utama → kirim index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Multer: simpan file di memori
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB per file
});

// Helper: strip common prefix folder (misal "my-website/")
function stripCommonPrefix(paths) {
  if (paths.length === 0) return paths;
  if (!paths[0].includes('/')) return paths;
  const parts = paths[0].split('/');
  let prefix = '';
  for (let i = 0; i < parts.length - 1; i++) {
    const test = prefix + parts[i] + '/';
    if (paths.every(p => p.startsWith(test))) prefix = test;
    else break;
  }
  return paths.map(p => p.substring(prefix.length));
}

// Helper: upload file ke Vercel Files API → dapat SHA
async function uploadFileToVercel(token, filename, buffer) {
  const sha = crypto.createHash('sha1').update(buffer).digest('hex');
  const res = await fetch('https://api.vercel.com/v2/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'x-vercel-filename': encodeURIComponent(filename),
      'x-vercel-digest': sha
    },
    body: buffer
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upload ${filename} gagal: ${errText}`);
  }
  return await res.json();
}

// ================== ENDPOINT DEPLOY ==================
app.post('/api/deploy', upload.any(), async (req, res) => {
  const { token, subdomain } = req.body;
  let files = req.files || [];
  const favicon = files.find(f => f.fieldname === 'favicon');
  files = files.filter(f => f.fieldname === 'files');

  if (!token || !subdomain) {
    return res.status(400).json({ error: 'Token dan subdomain wajib diisi.' });
  }
  if (files.length === 0) {
    return res.status(400).json({ error: 'Tidak ada file yang di-upload.' });
  }

  try {
    const paths = files.map(f => f.originalname);
    const strippedPaths = stripCommonPrefix(paths);

    // ============ SISIPKAN FAVICON KE <head> ============
    if (favicon) {
      const ext = path.extname(favicon.originalname).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml'
      };
      const mime = mimeMap[ext] || 'image/png';
      const faviconName = 'favicon' + ext;
      const faviconTag = `<link rel="icon" type="${mime}" href="/${faviconName}"><link rel="shortcut icon" type="${mime}" href="/${faviconName}">`;

      files.forEach((f) => {
        if (f.originalname.toLowerCase().endsWith('.html')) {
          let html = f.buffer.toString('utf-8');
          if (html.includes(faviconName)) return;
          if (/<\/head>/i.test(html)) {
            html = html.replace(/<\/head>/i, `    ${faviconTag}\n</head>`);
          } else if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/(<head[^>]*>)/i, `$1\n    ${faviconTag}`);
          } else if (/<html[^>]*>/i.test(html)) {
            html = html.replace(/(<html[^>]*>)/i, `$1\n<head>\n    ${faviconTag}\n</head>`);
          }
          f.buffer = Buffer.from(html, 'utf-8');
        }
      });

      files.push({ originalname: faviconName, buffer: favicon.buffer });
      strippedPaths.push(faviconName);
    }
    // ====================================================

    // ============ UPLOAD TIAP FILE KE VERCEL ============
    console.log(`Uploading ${files.length} files to Vercel...`);
    const fileRefs = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const filePath = strippedPaths[i];
      const result = await uploadFileToVercel(token, filePath, f.buffer);
      
      // ✅ PERBAIKAN: Tambahkan size (byte)
      fileRefs.push({ 
        file: filePath, 
        sha: result.sha, 
        size: f.buffer.length 
      });
      
      console.log(`  [${i + 1}/${files.length}] ${filePath} (${f.buffer.length} bytes)`);
    }

    // ============ BUAT DEPLOYMENT ============
    console.log('Creating deployment...');
    const deployRes = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: subdomain,
        files: fileRefs,
        target: 'production',
        projectSettings: {
          framework: null,
          buildCommand: null,
          outputDirectory: null,
          installCommand: null,
          devCommand: null
        }
      })
    });

    const deployData = await deployRes.json();
    if (!deployRes.ok) {
      throw new Error(deployData.error?.message || 'Gagal membuat deployment.');
    }

    const deployUrl = 'https://' + (deployData.url || `${subdomain}.vercel.app`);
    console.log('Deploy sukses:', deployUrl);

    res.json({ success: true, url: deployUrl });

  } catch (error) {
    console.error('Deploy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Zamzzx Deployer running on port ${PORT}`);
});
