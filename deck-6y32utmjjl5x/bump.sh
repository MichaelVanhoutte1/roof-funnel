#!/bin/bash
# Bump the cache-busting version on deck.css / deck.js after editing either file.
cd "$(dirname "$0")" && V=$(date -u +%Y%m%d%H%M) && sed -i '' -E "s/deck\.css(\?v=[^\"]*)?\"/deck.css?v=$V\"/; s/deck\.js(\?v=[^\"]*)?\"/deck.js?v=$V\"/" index.html && echo "deck assets now ?v=$V"
