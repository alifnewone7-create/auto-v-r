# VPS Setup Guide - 500+ Account Configuration

## A. Prerequisites Check

```bash
# Check system specs
nproc                    # CPU cores (need 4+)
free -h                  # RAM (need 16GB+)
df -h /                  # Disk (need 50GB+)

# Check Python version
python3 --version       # Need 3.9+
pip3 --version
```

## B. Initial Setup (First Time Only)

### 1. Update system packages
```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y python3-pip python3-venv git postgresql-client
```

### 2. Clone or setup project
```bash
cd /home/ubuntu
# If cloning from git:
git clone <your-repo> iamhear
cd iamhear/LS_Python

# Or copy existing code:
# scp -r local/path/LS_Python ubuntu@vps:/home/ubuntu/iamhear/LS_Python
```

### 3. Create Python virtual environment
```bash
cd /home/ubuntu/iamhear
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r LS_Python/requirements.txt
```

## C. Database Setup (Neon)

### 1. Get Neon connection string
```
Go to Neon Dashboard → Project → Connection String
Copy the full string (looks like):
postgresql://user:password@ep-xxx.neon.tech/dbname?sslmode=require
```

### 2. Test connection from VPS
```bash
source /home/ubuntu/iamhear/venv/bin/activate
python3 << 'EOF'
import psycopg2
import os

conn_str = "postgresql://user:password@ep-xxx.neon.tech/dbname?sslmode=require"
try:
    conn = psycopg2.connect(conn_str)
    print("[✓] Database connection successful")
    conn.close()
except Exception as e:
    print(f"[✗] Connection failed: {e}")
EOF
```

## D. Environment Configuration

### 1. Create .env file in LS_Python
```bash
cat > /home/ubuntu/iamhear/LS_Python/.env << 'EOF'
# ========== DATABASE ==========
DATABASE_URL=postgresql://user:password@ep-xxx.neon.tech/dbname?sslmode=require

# ========== PROFILE THROTTLE (CRITICAL for Telegram rate limits) ==========
# How many profile update jobs run concurrently (1-3; never >3)
AGENT_PROFILE_CONCURRENCY=2

# Seconds to wait between profile jobs (3-10; higher = safer from floods)
AGENT_PROFILE_DELAY_SECONDS=5

# ========== FLOOD RESILIENCE ==========
# Max retry attempts for rate-limited jobs (20-50)
AGENT_MAX_FLOOD_RETRIES=25

# ========== WORKER SCALING ==========
# Number of worker coroutines (tune to CPU cores: 4 cores = 4 workers)
AGENT_WORKERS=4

# Jobs to claim per batch (10-30; keep <50)
BATCH_SIZE=20

# Poll interval in seconds (1-3)
POLL_SECONDS=2

# ========== LOGGING ==========
LOG_LEVEL=INFO
EOF
```

### 2. Verify .env
```bash
cat /home/ubuntu/iamhear/LS_Python/.env
```

## E. Worker Startup Scripts

### 1. Create worker launcher script
```bash
cat > /home/ubuntu/iamhear/start_workers.sh << 'EOF'
#!/bin/bash
set -e

VENV="/home/ubuntu/iamhear/venv"
PROJECT="/home/ubuntu/iamhear/LS_Python"
LOG_DIR="/home/ubuntu/iamhear/logs"

# Create log directory
mkdir -p "$LOG_DIR"

# Load environment
source "$VENV/bin/activate"
cd "$PROJECT"

# Start multiple worker processes (one per CPU core, or fewer if memory limited)
NUM_WORKERS=4

echo "[$(date)] Starting $NUM_WORKERS workers..."

for i in $(seq 1 $NUM_WORKERS); do
    LOG_FILE="$LOG_DIR/worker_${i}.log"
    nohup python -m agent.worker >> "$LOG_FILE" 2>&1 &
    PID=$!
    echo "[$(date)] Worker $i started (PID: $PID) → $LOG_FILE"
    sleep 1  # Stagger startup
done

echo "[$(date)] All workers started. Check logs in $LOG_DIR"
ps aux | grep "agent.worker" | grep -v grep
EOF

chmod +x /home/ubuntu/iamhear/start_workers.sh
```

### 2. Create stop script
```bash
cat > /home/ubuntu/iamhear/stop_workers.sh << 'EOF'
#!/bin/bash
echo "[$(date)] Stopping all workers..."
pkill -f "python -m agent.worker" || true
sleep 2
ps aux | grep "agent.worker" | grep -v grep || echo "All workers stopped."
EOF

chmod +x /home/ubuntu/iamhear/stop_workers.sh
```

## F. Systemd Service (Recommended for Auto-Restart)

### 1. Create systemd service file
```bash
sudo tee /etc/systemd/system/iamhear-worker.service > /dev/null << 'EOF'
[Unit]
Description=iamhear Telegram Agent Workers
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/iamhear/LS_Python
Environment="PATH=/home/ubuntu/iamhear/venv/bin"
EnvironmentFile=/home/ubuntu/iamhear/LS_Python/.env
ExecStart=/home/ubuntu/iamhear/venv/bin/python -m agent.worker
Restart=on-failure
RestartSec=10
StandardOutput=append:/home/ubuntu/iamhear/logs/worker.log
StandardError=append:/home/ubuntu/iamhear/logs/worker.log

[Install]
WantedBy=multi-user.target
EOF
```

### 2. Enable and start service
```bash
sudo systemctl daemon-reload
sudo systemctl enable iamhear-worker.service
sudo systemctl start iamhear-worker.service

# Check status
sudo systemctl status iamhear-worker.service

# View logs
sudo journalctl -u iamhear-worker.service -f
```

## G. Manual Startup (If Not Using Systemd)

### Option 1: Simple screen/tmux
```bash
cd /home/ubuntu/iamhear
source venv/bin/activate

# Using screen
screen -S agent -d -m bash -c "cd LS_Python && python -m agent.worker"
screen -ls  # List sessions

# Or using tmux
tmux new-session -d -s agent -c /home/ubuntu/iamhear/LS_Python "source ../venv/bin/activate && python -m agent.worker"
tmux list-sessions
```

### Option 2: nohup (Simplest)
```bash
cd /home/ubuntu/iamhear
source venv/bin/activate
nohup python -m agent.worker >> logs/worker.log 2>&1 &
echo $! > logs/worker.pid
```

### Option 3: Multiple workers with start script
```bash
/home/ubuntu/iamhear/start_workers.sh

# Check they're running
ps aux | grep "agent.worker"
```

## H. Monitoring & Logs

### 1. Watch real-time logs
```bash
# Single file
tail -f /home/ubuntu/iamhear/logs/worker.log

# All logs with grep
tail -f /home/ubuntu/iamhear/logs/worker*.log | grep -E "\[OK\]|\[FAIL\]|\[WAIT\]"

# Count job statuses
grep -c "\[OK\]" /home/ubuntu/iamhear/logs/worker.log
grep -c "\[FAIL\]" /home/ubuntu/iamhear/logs/worker.log
grep -c "\[WAIT\]" /home/ubuntu/iamhear/logs/worker.log
```

### 2. Check database job status
```bash
source /home/ubuntu/iamhear/venv/bin/activate
python3 << 'EOF'
import psycopg2
import os

conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()

# Job counts by status
cur.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status")
print("\nJob Status Summary:")
for status, count in cur.fetchall():
    print(f"  {status}: {count}")

# Pending jobs
cur.execute("SELECT id, type, account_id FROM jobs WHERE status = 'queued' LIMIT 10")
print("\nPending Jobs (first 10):")
for job_id, jtype, acc_id in cur.fetchall():
    print(f"  Job #{job_id}: {jtype} (account {acc_id})")

cur.close()
conn.close()
EOF
```

### 3. Monitor processes
```bash
# Check worker processes
ps aux | grep "agent.worker"

# Memory usage
ps aux | grep "agent.worker" | awk '{print $6}' | paste -sd+ | bc

# CPU usage (if htop installed)
sudo apt install -y htop
htop -p $(pgrep -f "agent.worker" | tr '\n' ',' | sed 's/,$//')
```

## I. Troubleshooting

### Workers not starting?
```bash
# Check Python environment
source /home/ubuntu/iamhear/venv/bin/activate
python -c "import agent.worker; print('OK')"

# Check database connection
python3 -c "import psycopg2, os; psycopg2.connect(os.environ['DATABASE_URL'])"

# Check .env loaded
env | grep DATABASE_URL
```

### High memory usage?
```bash
# Reduce concurrent workers
# Edit .env: AGENT_WORKERS=2 (instead of 4)
# Or reduce warm accounts in database
```

### Telegram rate limits / FloodWait?
```bash
# Increase profile delay
# Edit .env: AGENT_PROFILE_DELAY_SECONDS=10 (instead of 5)

# Or reduce concurrency
# Edit .env: AGENT_PROFILE_CONCURRENCY=1
```

### Database connection timeout?
```bash
# Check Neon is reachable
ping ep-xxx.neon.tech

# Verify connection string
cat /home/ubuntu/iamhear/LS_Python/.env | grep DATABASE_URL
```

## J. Restart & Maintenance

### Graceful restart
```bash
# Stop workers
/home/ubuntu/iamhear/stop_workers.sh

# Wait for graceful shutdown (jobs finish)
sleep 30

# Pull latest code (if using git)
cd /home/ubuntu/iamhear
git pull

# Start workers
/home/ubuntu/iamhear/start_workers.sh
```

### View recent jobs
```bash
tail -100 /home/ubuntu/iamhear/logs/worker.log | tail -20
```

### Update configuration
```bash
# Edit .env
nano /home/ubuntu/iamhear/LS_Python/.env

# Restart workers
sudo systemctl restart iamhear-worker.service
# (or manually stop and restart)
```

## K. 500+ Account Configuration Summary

```
AGENT_WORKERS=4                  # For 4-core VPS
AGENT_PROFILE_CONCURRENCY=2      # Never >3
AGENT_PROFILE_DELAY_SECONDS=5    # Safe default
AGENT_MAX_FLOOD_RETRIES=25       # Allow retries
BATCH_SIZE=20                    # Claim per round
DATABASE_URL=<neon-connection>   # From Neon dashboard
```

---

## Quick Start Checklist

- [ ] VPS specs: 4+ cores, 16GB RAM, 50GB+ disk
- [ ] Python 3.9+ installed
- [ ] Virtual environment created & activated
- [ ] Dependencies installed (`pip install -r requirements.txt`)
- [ ] Neon DATABASE_URL obtained and tested
- [ ] .env file created with all configs
- [ ] Worker startup script created
- [ ] Workers started (systemd or manual)
- [ ] Logs being written to `/home/ubuntu/iamhear/logs/`
- [ ] Database job counts queried and verified
- [ ] Monitoring setup (tail -f logs)

---

Need help? Check logs first: `tail -f /home/ubuntu/iamhear/logs/worker.log`
