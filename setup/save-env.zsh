#!/bin/zsh
# Save keys to the repository's .env (git ignored, readable only by you), one at a time, hidden as you type.
# Press Enter on any prompt to keep what is already saved. Nothing is ever printed.
cd "${0:A:h}/.."
umask 077
touch .env
ask() {
  local name=$1 prompt=$2 value
  read -s "value?$prompt (Enter to keep current): "
  echo
  if [[ -n $value ]]; then
    grep -v "^$name=" .env > .env.tmp 2>/dev/null; mv .env.tmp .env
    print -r -- "$name=$value" >> .env
    echo "  saved $name"
  fi
}
ask APOLLO_API_KEY "Apollo API key"
ask SLACK_BOT_TOKEN "Slack bot token (starts with xoxb-)"
ask SLACK_CHANNEL "Slack channel ID (starts with C)"
chmod 600 .env
echo "Done. Saved names: $(cut -d= -f1 .env | tr '\n' ' ')"
