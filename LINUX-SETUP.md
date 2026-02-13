# Linux Installation Guide

MyBot runs **natively on Linux** with excellent performance. This is actually the recommended platform!

## Quick Install (Ubuntu/Debian)

```bash
# 1. Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Logout and login for group changes to take effect

# 3. Clone/download the project
cd ~/projects
# (copy your bot files here)

# 4. Install dependencies
npm install

# 5. Configure environment
cp .env.example .env
nano .env  # Add your API keys

# 6. Start the bot
npm start
```

## Platform-Specific Notes

### Docker on Linux

Linux has **native Docker support** (no VM overhead like macOS/Windows), which means:
- ✅ Better performance
- ✅ Lower resource usage
- ✅ Faster container startup
- ✅ More reliable sandbox isolation

### File Locations

- **Bot files:** Wherever you cloned them (e.g., `/home/username/mybot/`)
- **Database:** `~/.mybot/mybot.db`
- **Obsidian vault:** `~/.mybot/obsidian-vault/`
- **WhatsApp auth:** `~/.mybot/whatsapp-auth/`
- **Docker workspace:** `/tmp/mybot-*` (temporary sandboxes)

### Other Linux Distributions

**Fedora/RHEL/CentOS:**
```bash
# Node.js
sudo dnf install nodejs

# Docker
sudo dnf install docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker $USER
```

**Arch Linux:**
```bash
# Node.js
sudo pacman -S nodejs npm

# Docker
sudo pacman -S docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker $USER
```

## Running as a Service (systemd)

Create `/etc/systemd/system/mybot.service`:

```ini
[Unit]
Description=MyBot AI Assistant
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/mybot
ExecStart=/usr/bin/node /home/youruser/mybot/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable mybot
sudo systemctl start mybot
sudo systemctl status mybot

# View logs
journalctl -u mybot -f
```

## Docker Troubleshooting

**Permission denied error:**
```bash
# Make sure you're in docker group
sudo usermod -aG docker $USER
# Then logout and login again
```

**Docker daemon not running:**
```bash
sudo systemctl start docker
sudo systemctl enable docker  # Start on boot
```

**Test Docker:**
```bash
docker run hello-world
docker info
```

## Performance Tips

1. **SSD recommended** for database and Docker volumes
2. **At least 2GB RAM** (4GB+ recommended for multiple models)
3. **Docker prune regularly:** `docker system prune -af` (removes old containers/images)

## Security Notes

Linux provides the best security profile for this bot:
- Native container isolation (no VM layer)
- Full cgroup/namespace support
- SELinux/AppArmor available for additional hardening
- Native user/permission model

Consider:
- Running bot as dedicated user (not root)
- Enabling firewall (ufw/iptables)
- Regular system updates

## Comparison: Linux vs WSL2 vs macOS

| Feature | Linux Native | WSL2 | macOS |
|---------|-------------|------|-------|
| Performance | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Docker Speed | Fastest | Fast | Good |
| Setup Complexity | Easy | Medium | Easy |
| Resource Usage | Lowest | Medium | Medium |
| Recommended? | ✅ Yes! | ✅ Yes | ✅ Yes |

## Production Deployment

For production use on Linux servers:

1. **Use systemd service** (see above)
2. **Set up log rotation**
3. **Configure firewall** (only if exposing ports)
4. **Enable auto-restart** on failure
5. **Monitor with journalctl** or external tools
6. **Regular backups** of `~/.mybot/` directory

## Cloud Deployment

Works great on:
- **DigitalOcean Droplets** (Ubuntu 22.04+)
- **AWS EC2** (Amazon Linux / Ubuntu)
- **Google Cloud Compute Engine**
- **Linode** 
- **Hetzner**

Minimum specs: 1 vCPU, 2GB RAM, 20GB disk

## Questions?

Linux is the **recommended platform** for MyBot! You get:
- Best performance
- Native Docker support
- Production-ready
- Lower costs (can run on cheaper VPS)

Check main README.md for general setup instructions.
