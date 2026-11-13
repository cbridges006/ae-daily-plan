#!/bin/zsh
# Save one key to the repository's .env (git ignored, readable only by you), hidden as you type.
#   zsh setup/save-one.zsh APOLLO_API_KEY
cd "${0:A:h}/.."
name=${1:?name the key, for example APOLLO_API_KEY}
umask 077
touch .env
read -s "value?Paste $name (hidden), then Enter: "
echo
if [[ -z $value ]]; then echo "Nothing pasted; $name unchanged."; exit 1; fi
grep -v "^$name=" .env > .env.tmp 2>/dev/null; mv .env.tmp .env
print -r -- "$name=$value" >> .env
chmod 600 .env
echo "Saved $name."
