const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const BackgammonParser = require('./backgammon-parser');
require('dotenv').config();

/**
 * DailyGammon Match Retriever
 * Logs into dailygammon.com and retrieves export links for finished matches
 */
class DailyGammonRetriever {
    constructor() {
        this.baseURL = 'http://dailygammon.com';
        // Create an HTTP agent that doesn't reuse sockets to avoid ECONNRESET
        const httpAgent = new http.Agent({
            keepAlive: false
        });
        this.session = axios.create({
            baseURL: this.baseURL,
            timeout: 10000,
            httpAgent: httpAgent,
            // Keep cookies for session management
            withCredentials: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        this.currentUserId = null;
    }

    /**
     * Programmatic entry point to retrieve and write parsed matches to a file.
     * The caller may choose the output file name.
     * Returns the parsed matches for further processing.
     * @param {string} outputFile
     * @returns {Promise<Object[]>}
     */
    static async main(outputFile = 'update.json') {
        console.log('Starting DailyGammonRetriever...');
        const username = process.env.DG_USERNAME || 'your_username';
        const password = process.env.DG_PASSWORD || 'your_password';
        const days = parseInt(process.env.DG_DAYS) || 30;
        const userId = process.env.DG_USER_ID || '36594';

        if (username === 'your_username' || password === 'your_password') {
            console.log('Please set environment variables:');
            console.log('DG_USERNAME=your_username DG_PASSWORD=your_password node index.js');
            console.log('Optional: DG_DAYS=30 DG_USER_ID=36594');
            return [];
        }

        const retriever = new DailyGammonRetriever();
        try {
            const exportLinks = await retriever.getFinishedMatches(username, password, days, userId);
            console.log('\nExport links found:');
            const fullUrls = retriever.getFullExportUrls(exportLinks);
            fullUrls.forEach((url, index) => {
                console.log(`${index + 1}. ${url}`);
            });

            console.log('\nDownloading and parsing matches...');
            const parsedMatches = await retriever.getAndParseMatches(username, password, days, userId);

            // Save parsed matches to file for analysis
            const fs = require('fs');
            fs.writeFileSync(outputFile, JSON.stringify(parsedMatches, null, 2));
            console.log(`\nParsed matches saved to: ${outputFile}`);

            return parsedMatches;
        } catch (error) {
            console.error('Failed to retrieve matches:', error.message);
            throw error;
        }
    }

    /**
     * Login to DailyGammon with retry logic.
     * Retries up to maxAttempts times (10s timeout each, 2s pause between).
     * @param {string} username - DailyGammon username
     * @param {string} password - DailyGammon password
     * @param {{ onProgress?: (p: any) => void, maxAttempts?: number }} [options]
     * @returns {Promise<boolean>} - Success status
     */
    async login(username, password, options = {}) {
        const maxAttempts = options.maxAttempts || 5;
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`Attempting to login as ${username} (attempt ${attempt}/${maxAttempts})...`);

                const loginPageResponse = await this.session.get('/bg/top');

                const cookies = loginPageResponse.headers['set-cookie'] || [];
                let cookieHeader = cookies.map(cookie => cookie.split(';')[0]).join('; ');

                const loginData = new URLSearchParams({
                    'path': 'top/',
                    'login': username,
                    'password': password,
                    'save': 'on'
                });

                const loginResponse = await this.session.post('/bg/login', loginData, {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Cookie': cookieHeader
                    },
                    maxRedirects: 5
                });

                const newCookies = loginResponse.headers['set-cookie'] || [];
                if (newCookies.length > 0) {
                    cookieHeader = newCookies.map(cookie => cookie.split(';')[0]).join('; ');
                    this.session.defaults.headers['Cookie'] = cookieHeader;
                }

                const loginHtml = loginResponse.data;
                const extractedId = this.extractUserIdFromHtml(loginHtml);
                if (extractedId) {
                    this.currentUserId = extractedId;
                }
                if (loginHtml.includes('Welcome to DailyGammon')) {
                    console.log('Login successful!');
                    return true;
                } else {
                    console.log('Login failed - no welcome message found');
                    return false;
                }
            } catch (error) {
                const isTimeout = error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'));
                const isNetworkError = isTimeout || error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND';

                if (isNetworkError && attempt < maxAttempts) {
                    console.warn(`Login attempt ${attempt}/${maxAttempts} failed: ${error.message}. Retrying in 2s...`);
                    if (onProgress) {
                        onProgress({
                            phase: 'dg_slow',
                            attempt,
                            maxAttempts,
                            message: `DailyGammon is responding slowly (attempt ${attempt}/${maxAttempts}). Retrying...`
                        });
                    }
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
                console.error('Login error:', error.message);
                return false;
            }
        }
        return false;
    }

    /**
     * Retrieve finished matches for a user within specified days
     * @param {string} username - DailyGammon username
     * @param {string} password - DailyGammon password  
     * @param {number} days - Number of days to look back (default: 30)
     * @param {string} userId - User ID (default: 36594 from prompt)
     * @param {{ onProgress?: (p: any) => void }} [options]
     * @returns {Promise<string[]>} - Array of export link hrefs
     */
    async getFinishedMatches(username, password, days = 30, userId = null, options = {}) {
        try {
            const loginSuccess = await this.login(username, password, options);
            if (!loginSuccess) {
                throw new Error('Failed to login');
            }

            console.log(`Retrieving matches for the last ${days} days...`);

            let effectiveUserId = userId || this.currentUserId;
            if (!effectiveUserId) {
                effectiveUserId = await this.fetchUserIdFromTop();
            }
            if (!effectiveUserId) {
                throw new Error('Unable to determine user id for DailyGammon');
            }

            // Construct the matches URL based on the pattern in the prompt
            const matchesUrl = `/bg/user/${effectiveUserId}?days_to_view=${days}&active=1&finished=1`;

            console.log(`Getting matches from ${matchesUrl}`);

            // Get the matches page
            const matchesResponse = await this.session.get(matchesUrl);
            const matchesHtml = matchesResponse.data;

            // Parse HTML to extract export links
            const exportLinks = this.parseExportLinks(matchesHtml);

            console.log(`Found ${exportLinks.length} export links`);
            return exportLinks;

        } catch (error) {
            console.error('Error retrieving matches:', error.message);
            throw error;
        }
    }

    /**
     * Parse HTML to extract export links, excluding ANTI-Backgammon matches.
     * Event titles are read from the same table row. Rows with "ANTI" (uppercase)
     * followed by "Backgammon" or "BACKGAMMON" (hyphen or space) are skipped.
     * @param {string} html - HTML content from matches page
     * @returns {string[]} - Array of export link hrefs
     */
    parseExportLinks(html) {
        const $ = cheerio.load(html);
        const exportLinks = [];
        const antiPatterns = ['ANTI-Backgammon', 'ANTI Backgammon', 'ANTI-BACKGAMMON', 'ANTI BACKGAMMON'];

        $('a[href*="/bg/export/"]').each((index, element) => {
            const href = $(element).attr('href');
            if (!href || !href.startsWith('/bg/export/')) return;

            const row = $(element).closest('tr');
            if (row.length === 0) {
                exportLinks.push(href);
                return;
            }

            const eventLink = row.find('a[href*="/bg/event/"]').first();
            const eventText = (eventLink.text() || '').trim();
            if (eventText.length > 0) {
                if (antiPatterns.some(p => eventText.includes(p))) {
                    return;
                }
            }

            exportLinks.push(href);
        });

        return exportLinks;
    }

    extractUserIdFromHtml(html) {
        if (typeof html !== 'string') return null;
        // Look for the "active matches" link which contains the current user's ID
        // Pattern: /bg/user/36594?days_to_view=...
        const match = html.match(/\/bg\/user\/(\d+)\?days_to_view=/i);
        return match ? match[1] : null;
    }

    async fetchUserIdFromTop() {
        try {
            const response = await this.session.get('/bg/top');
            const userId = this.extractUserIdFromHtml(response.data);
            if (userId) {
                this.currentUserId = userId;
                return userId;
            }
        } catch (error) {
            console.error('Error resolving user id from top page:', error.message);
        }
        return null;
    }

    async resolveUserId(username, password, options = {}) {
        const loginSuccess = await this.login(username, password, options);
        if (!loginSuccess) {
            throw new Error('Failed to login to resolve user id');
        }
        if (this.currentUserId) return this.currentUserId;
        const resolved = await this.fetchUserIdFromTop();
        if (!resolved) {
            throw new Error('Unable to resolve DailyGammon user id');
        }
        return resolved;
    }

    /**
     * Get full URLs for export links
     * @param {string[]} exportHrefs - Array of relative export hrefs
     * @returns {string[]} - Array of full export URLs
     */
    getFullExportUrls(exportHrefs) {
        return exportHrefs.map(href => `${this.baseURL}${href}`);
    }

    /**
     * Download and parse matches into structured JSON
     * @param {string} username - DailyGammon username
     * @param {string} password - DailyGammon password  
     * @param {number} days - Number of days to look back (default: 30)
     * @param {string} userId - User ID (default: 36594 from prompt)
     * @param {{ onProgress?: (p: any) => void }} [options]
     * @returns {Promise<Object[]>} - Array of parsed match data
     */
    async getAndParseMatches(username, password, days = 30, userId = '36594', options = {}) {
        try {
            const exportLinks = await this.getFinishedMatches(username, password, days, userId, options);

            if (exportLinks.length === 0) {
                console.log('No matches found for the specified time period');
                return [];
            }

            // Convert to full URLs
            const fullUrls = this.getFullExportUrls(exportLinks);

            // Parse all matches
            console.log(`Parsing ${fullUrls.length} matches...`);
            const parser = new BackgammonParser();
            const parsedMatches = await parser.parseMultipleMatches(fullUrls, this.session);

            console.log(`Successfully parsed ${parsedMatches.filter(m => !m.error).length} matches`);

            return parsedMatches;
        } catch (error) {
            console.error('Error getting and parsing matches:', error.message);
            throw error;
        }
    }
}

// CLI wrapper that uses the static main, allowing optional env override for output
async function cliMain() {
    const defaultFile = `parsed_matches_${new Date().toISOString().split('T')[0]}.json`;
    const outputFile = process.env.DG_OUTPUT_FILE || defaultFile;
    await DailyGammonRetriever.main(outputFile);
}

// Export the class for use as a module
module.exports = DailyGammonRetriever;

// Run main function if this file is executed directly
if (require.main === module) {
    cliMain();
} 