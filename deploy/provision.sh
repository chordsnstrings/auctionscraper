#!/usr/bin/env bash
#
# provision.sh — create the Ecosine project and droplet on DigitalOcean.
#
#   DO_TOKEN=dop_v1_... ./deploy/provision.sh
#
# Strictly additive. It creates a project and one droplet and does not read,
# modify, move or delete any pre-existing resource. Re-running it is safe: it
# reuses the project and droplet if they already exist.
#
# Cost: one s-1vcpu-1gb droplet, $6/month. Nothing else is provisioned — the
# SQLite database lives on the droplet's own 25 GB disk, which is why there is
# no managed-database line item.
set -euo pipefail

: "${DO_TOKEN:?DO_TOKEN must be set}"

PROJECT_NAME="${PROJECT_NAME:-Ecosine Auction Intelligence}"
DROPLET_NAME="${DROPLET_NAME:-ecosine-auction}"
REGION="${REGION:-blr1}"            # closest DO region to the UAE
SIZE="${SIZE:-s-1vcpu-1gb}"         # $6/mo, 1 GB RAM, 25 GB disk
IMAGE="${IMAGE:-ubuntu-24-04-x64}"
BRANCH="${BRANCH:-claude/microanimations-aesthetic-polish-q0pgm5}"

API=https://api.digitalocean.com/v2
auth=(-H "Authorization: Bearer $DO_TOKEN" -H 'Content-Type: application/json')
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

jq_() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d||'{}');console.log(eval(process.argv[1])??'')})" "$1"; }

say() { printf '  %s\n' "$*"; }

# ── outbound status topic (the droplet reports; nothing listens inbound) ───
TOPIC_FILE="${TOPIC_FILE:-$here/.ntfy-topic}"
if [ ! -f "$TOPIC_FILE" ]; then
  node -e 'process.stdout.write("ecosine-"+require("crypto").randomBytes(12).toString("hex"))' > "$TOPIC_FILE"
  chmod 600 "$TOPIC_FILE"
fi
NTFY_TOPIC="$(cat "$TOPIC_FILE")"

# ── source payload (private repo, and no inbound path to push it later) ────
PKG=/tmp/ecosine-pkg
rm -rf "$PKG"; mkdir -p "$PKG/src/digest"
cp "$here/../src"/*.ts "$PKG/src/"
cp "$here/../src/digest"/*.ts "$PKG/src/digest/"
rm -f "$PKG/src/preview.ts" "$PKG/src/responsive.ts" "$PKG/src/verify.ts"   # dev tooling
cp "$here/../package.json" "$here/../tsconfig.json" "$PKG/"
node -e 'const fs=require("fs"),f=process.argv[1]+"/package.json",p=JSON.parse(fs.readFileSync(f,"utf8"));
for(const k of ["preview","check:responsive","verify"])delete p.scripts[k];
fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$PKG"
tar cf - -C "$PKG" . | bzip2 -9 > /tmp/ecosine-src.tbz2
SRC_B64="$(base64 -w0 /tmp/ecosine-src.tbz2)"

USER_DATA="$(sed -e "s|__NTFY__|$NTFY_TOPIC|g" -e "s|__BRANCH__|$BRANCH|g" "$here/cloud-init.yaml")"
USER_DATA="${USER_DATA//__SRC_B64__/$SRC_B64}"

bytes=$(printf '%s' "$USER_DATA" | wc -c)
say "user_data: ${bytes} bytes (limit 65536)"
[ "$bytes" -lt 65536 ] || { echo "user_data too large" >&2; exit 1; }

# ── project (reuse if present) ─────────────────────────────────────────────
PROJECT_ID="$(curl -sS "${auth[@]}" "$API/projects" | jq_ "(o.projects.find(p=>p.name===$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$PROJECT_NAME"))||{}).id")"
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="$(curl -sS -X POST "${auth[@]}" "$API/projects" -d "$(node -e '
    console.log(JSON.stringify({name:process.argv[1],description:"Daily Al Qaryah auction screen for Ecosine Transport fleet purchasing.",purpose:"Service or API",environment:"Production"}))' "$PROJECT_NAME")" | jq_ 'o.project.id')"
  say "created project $PROJECT_ID"
else
  say "reusing project $PROJECT_ID"
fi

# ── ssh keys: attach every key already on the account so the owner keeps access
SSH_IDS="$(curl -sS "${auth[@]}" "$API/account/keys" | jq_ 'JSON.stringify((o.ssh_keys||[]).map(k=>k.id))')"
say "ssh keys attached: $SSH_IDS"

# ── droplet (reuse if present) ─────────────────────────────────────────────
DROPLET_ID="$(curl -sS "${auth[@]}" "$API/droplets?per_page=200" | jq_ "((o.droplets||[]).find(d=>d.name==='$DROPLET_NAME')||{}).id")"
if [ -z "$DROPLET_ID" ]; then
  body="$(node -e '
    const [name,region,size,image,ud,keys]=process.argv.slice(1);
    console.log(JSON.stringify({name,region,size,image,ssh_keys:JSON.parse(keys),
      backups:false,ipv6:true,monitoring:true,user_data:ud,tags:["ecosine","auction-screen"]}));
  ' "$DROPLET_NAME" "$REGION" "$SIZE" "$IMAGE" "$USER_DATA" "$SSH_IDS")"
  DROPLET_ID="$(printf '%s' "$body" | curl -sS -X POST "${auth[@]}" "$API/droplets" --data-binary @- | jq_ 'o.droplet?o.droplet.id:JSON.stringify(o)')"
  say "created droplet $DROPLET_ID"
else
  say "reusing droplet $DROPLET_ID"
fi

# ── wait for an address ────────────────────────────────────────────────────
IP=""
for i in $(seq 1 60); do
  IP="$(curl -sS "${auth[@]}" "$API/droplets/$DROPLET_ID" | jq_ "((o.droplet.networks.v4||[]).find(n=>n.type==='public')||{}).ip_address")"
  [ -n "$IP" ] && break
  sleep 5
done
say "public ip: ${IP:-<pending>}"

# ── assign to the project (moves only this droplet) ────────────────────────
curl -sS -X POST "${auth[@]}" "$API/projects/$PROJECT_ID/resources" \
  -d "{\"resources\":[\"do:droplet:$DROPLET_ID\"]}" >/dev/null
say "assigned droplet to project"

cat <<EOF

  droplet   $DROPLET_NAME ($DROPLET_ID)
  ip        $IP
  project   $PROJECT_NAME ($PROJECT_ID)
  cost      \$6/month

  Nothing listens inbound; the droplet reports outward.
  Watch provisioning:
    curl -s "https://ntfy.sh/$NTFY_TOPIC/json?poll=1"
EOF
