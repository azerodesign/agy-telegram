#!/usr/bin/env bash
sudo systemctl status agy-telegram --no-pager
echo ""
echo "--- 10 Baris Log Terakhir ---"
sudo journalctl -u agy-telegram -n 10 --no-pager
