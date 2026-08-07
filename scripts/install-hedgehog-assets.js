'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const assetDir = process.env.HEDGEHOG_ASSET_DIR || path.join(projectRoot, 'vendor', 'hedgehog');
const manifestPath = process.env.HEDGEHOG_MANIFEST_PATH || path.join(assetDir, 'manifest.json');

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function installFile(label, entry) {
    const destination = path.join(assetDir, entry.name);
    if (fs.existsSync(destination)) {
        const existingHash = sha256(await fs.promises.readFile(destination));
        if (existingHash === entry.sha256) {
            console.log(`${label}: already installed (${entry.name})`);
            return;
        }
    }

    console.log(`${label}: downloading ${entry.url}`);
    const response = await fetch(entry.url);
    if (!response.ok) throw new Error(`${entry.url} returned HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    const actualHash = sha256(data);
    if (actualHash !== entry.sha256) {
        throw new Error(`${label} checksum mismatch: expected ${entry.sha256}, received ${actualHash}`);
    }

    const temporary = `${destination}.download`;
    await fs.promises.writeFile(temporary, data);
    await fs.promises.rename(temporary, destination);
    console.log(`${label}: installed ${entry.name} (${data.length} bytes)`);
}

async function main() {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    const args = process.argv.slice(2);
    const requested = args[0] || process.env.HEDGEHOG_MODEL || manifest.defaultModel;
    const modelIds = requested === '--all' ? Object.keys(manifest.models || {}) : [requested];
    for (const modelId of modelIds) {
        if (!manifest.models?.[modelId]) {
            throw new Error(
                `Unknown model '${modelId}'. Available models: ${Object.keys(manifest.models || {}).join(', ')}`
            );
        }
    }

    await fs.promises.mkdir(assetDir, { recursive: true });
    for (const [label, entry] of Object.entries(manifest.files || {})) {
        await installFile(label, entry);
    }
    for (const modelId of modelIds) {
        await installFile(`model ${modelId}`, manifest.models[modelId]);
    }
    console.log(`Hedgehog assets are ready for: ${modelIds.join(', ')}.`);
    console.log(`Terms: ${manifest.source}`);
}

main().catch((error) => {
    console.error(`Hedgehog installation failed: ${error.message}`);
    process.exitCode = 1;
});
