'use strict';

// Copies the browser build of DarkBGHelmet into public/engine/, the engine the
// quiz page runs in the browser. The app uses exactly the copied version until
// this script runs again, independent of the engine's own development.
//
//   node scripts/update-browser-engine.js [path to DarkBGHelmet] [--net nets/other.bgnn]
//
// The DarkBGHelmet folder defaults to ../DarkBGHelmet; build its web/ files
// first with tools/build_wasm.sh there. The network is the one the server
// engine (bgserver) should be running: the quiz page uses the browser engine
// only while both report the same network (see public/engineClient.js).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILES = ['bghelmet.js', 'worker.js', 'bghelmet-core.js', 'bghelmet-core.wasm', 'bghelmet-core-mt.js', 'bghelmet-core-mt.wasm'];
const target = path.resolve(__dirname, '..', 'public', 'engine');

function parseArgs(argv) {
    const options = { source: path.resolve(__dirname, '..', '..', 'DarkBGHelmet'), net: 'nets/latest.bgnn' };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--net' && argv[index + 1]) options.net = argv[++index];
        else if (!arg.startsWith('--')) options.source = path.resolve(arg);
        else throw new Error(`Unknown or incomplete argument '${arg}'`);
    }
    return options;
}

function git(source, args) {
    try {
        return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

async function main() {
    const { source, net } = parseArgs(process.argv.slice(2));
    const missing = [...FILES.map((file) => path.join('web', file)), net]
        .filter((file) => !fs.existsSync(path.join(source, file)));
    if (missing.length) throw new Error(`Missing in ${source}: ${missing.join(', ')} (run tools/build_wasm.sh there)`);

    fs.mkdirSync(target, { recursive: true });
    for (const file of FILES) fs.copyFileSync(path.join(source, 'web', file), path.join(target, file));
    fs.copyFileSync(path.join(source, net), path.join(target, 'engine.bgnn'));

    // Load the copy once: a smoke test, and the network id the page compares with the server's.
    const BGHelmet = require(path.join(target, 'bghelmet.js'));
    const engine = await BGHelmet.load({ net: path.join(target, 'engine.bgnn'), threads: 1 });
    const info = engine.info();
    const status = git(source, ['status', '--porcelain', '--', 'web', 'engine', net]);
    const version = {
        engine: info.name,
        version: info.version,
        network: info.network,
        networkFile: net,
        commit: git(source, ['rev-parse', '--short', 'HEAD']),
        uncommittedChanges: Boolean(status),
        copiedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(target, 'VERSION.json'), `${JSON.stringify(version, null, 2)}\n`);
    console.log(`Copied ${info.name} ${info.version} (commit ${version.commit}${version.uncommittedChanges ? ', with uncommitted changes' : ''}), network ${info.network}, to ${path.relative(process.cwd(), target)}`);
    process.exit(0);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
