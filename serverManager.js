const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');
const fs = require('fs');

class ServerManager {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.process = null;
    this.port = 0;
    this.ready = false;
  }

  async start() {
    if (this.ready) return this.port;

    this.port = await this._findFreePort();

    const candidates = [
      path.join(this.extensionUri.fsPath, 'media', 'server.py'),
      path.join(this.extensionUri.fsPath, 'server.py'),
      path.join(__dirname, 'media', 'server.py'),
      path.join(__dirname, 'server.py')
    ];

    const serverPath = candidates.find(p => fs.existsSync(p));
    if (!serverPath) {
      throw new Error('server.py not found. Extension root ya media/ folder me rakho.');
    }

    this.process = spawn('python3', [serverPath], {
      env: { ...process.env, PORT: this.port.toString(), HOST: '127.0.0.1' },
      cwd: path.dirname(serverPath)
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15000);
      let output = '';

      const checkReady = (data) => {
        output += data.toString();
        if (output.includes('Serving C++ Flow Studio')) {
          clearTimeout(timeout);
          this.ready = true;
          resolve();
        }
      };

      this.process.stdout.on('data', checkReady);
      this.process.stderr.on('data', checkReady);
      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return this.port;
  }

  async trace(code) {
    if (!this.ready) await this.start();

    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ code });
      const options = {
        hostname: '127.0.0.1',
        port: this.port,
        path: '/api/trace',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.details ? `${parsed.error}\n${parsed.details}` : parsed.error));
            }
          } catch (e) {
            reject(new Error('Tracer se invalid response aaya.'));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  _findFreePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  dispose() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.ready = false;
  }
}

module.exports = { ServerManager };