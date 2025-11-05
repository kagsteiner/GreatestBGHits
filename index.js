const axios = require('axios');
const cheerio = require('cheerio');
const BackgammonParser = require('./backgammon-parser');
require('dotenv').config();

/**
 * DailyGammon Match Retriever
 * Logs into dailygammon.com and retrieves export links for finished matches
 */
class DailyGammonRetriever {
    constructor() {
        this.baseURL = 'http://dailygammon.com';
        this.session = axios.create({
            baseURL: this.baseURL,
            timeout: 10000,
            // Keep cookies for session management
            withCredentials: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
    }

    /**
     * Login to DailyGammon
     * @param {string} username - DailyGammon username
     * @param {string} password - DailyGammon password
     * @returns {Promise<boolean>} - Success status
     */
    async login(username, password) {
        try {
            console.log(`Attempting to login as ${username}...`);

            // First, get the login page to establish session
            const loginPageResponse = await this.session.get('/bg/top');

            // Extract any cookies from the initial request
            const cookies = loginPageResponse.headers['set-cookie'] || [];
            let cookieHeader = cookies.map(cookie => cookie.split(';')[0]).join('; ');

            // Prepare login data based on the form in the prompt
            const loginData = new URLSearchParams({
                'path': 'top/',
                'login': username,
                'password': password,
                'save': 'on'  // Remember login
            });

            // Perform login POST request
            const loginResponse = await this.session.post('/bg/login', loginData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': cookieHeader
                },
                maxRedirects: 5
            });

            // Update cookies from login response
            const newCookies = loginResponse.headers['set-cookie'] || [];
            if (newCookies.length > 0) {
                cookieHeader = newCookies.map(cookie => cookie.split(';')[0]).join('; ');
                this.session.defaults.headers['Cookie'] = cookieHeader;
            }

            // Check if login was successful by looking for welcome message
            const loginHtml = loginResponse.data;
            if (loginHtml.includes('Welcome to DailyGammon')) {
                console.log('Login successful!');
                return true;
            } else {
                console.log('Login failed - no welcome message found');
                return false;
            }
        } catch (error) {
            console.error('Login error:', error.message);
            return false;
        }
    }

    /**
     * Retrieve finished matches for a user within specified days
     * @param {string} username - DailyGammon username
     * @param {string} password - DailyGammon password  
     * @param {number} days - Number of days to look back (default: 30)
     * @param {string} userId - User ID (default: 36594 from prompt)
     * @returns {Promise<string[]>} - Array of export link hrefs
     */
    async getFinishedMatches(username, password, days = 30, userId = '36594') {
        try {
            // Login first
            const loginSuccess = await this.login(username, password);
            if (!loginSuccess) {
                throw new Error('Failed to login');
            }

            console.log(`Retrieving matches for the last ${days} days...`);

            // Construct the matches URL based on the pattern in the prompt
            const matchesUrl = `/bg/user/${userId}?days_to_view=${days}&active=1&finished=1`;

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
     * Parse HTML to extract export links
     * @param {string} html - HTML content from matches page
     * @returns {string[]} - Array of export link hrefs
     */
    parseExportLinks(html) {
        const $ = cheerio.load(html);
        const exportLinks = [];

        // Look for links with href matching the export pattern
        // Pattern: <A href=/bg/export/MATCHID>Export</A>
        $('a[href*="/bg/export/"]').each((index, element) => {
            const href = $(element).attr('href');
            if (href && href.startsWith('/bg/export/')) {
                exportLinks.push(href);
            }
        });

        return exportLinks;
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
     * @returns {Promise<Object[]>} - Array of parsed match data
     */
    async getAndParseMatches(username, password, days = 30, userId = '36594') {
        try {
            // Get export links
            const exportLinks = await this.getFinishedMatches(username, password, days, userId);

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

/**
 * Main function to demonstrate usage
 */
async function main() {
    console.log('Starting DailyGammonRetriever...');
    // Example usage - replace with actual credentials
    const username = process.env.DG_USERNAME || 'your_username';
    const password = process.env.DG_PASSWORD || 'your_password';
    const days = parseInt(process.env.DG_DAYS) || 30;
    const userId = process.env.DG_USER_ID || '36594';

    if (username === 'your_username' || password === 'your_password') {
        console.log('Please set environment variables:');
        console.log('DG_USERNAME=your_username DG_PASSWORD=your_password node index.js');
        console.log('Optional: DG_DAYS=30 DG_USER_ID=36594');
        return;
    }

    const retriever = new DailyGammonRetriever();

    try {
        // Option 1: Just get export links
        const exportLinks = await retriever.getFinishedMatches(username, password, days, userId);
        console.log('\nExport links found:');
        const fullUrls = retriever.getFullExportUrls(exportLinks);
        fullUrls.forEach((url, index) => {
            console.log(`${index + 1}. ${url}`);
        });

        // Option 2: Download and parse all matches
        console.log('\nDownloading and parsing matches...');
        const parsedMatches = await retriever.getAndParseMatches(username, password, days, userId);

        // Save parsed matches to file for analysis
        const fs = require('fs');
        const outputFile = `parsed_matches_${new Date().toISOString().split('T')[0]}.json`;
        fs.writeFileSync(outputFile, JSON.stringify(parsedMatches, null, 2));
        console.log(`\nParsed matches saved to: ${outputFile}`);

        return { exportLinks, parsedMatches };
    } catch (error) {
        console.error('Failed to retrieve matches:', error.message);
        process.exit(1);
    }
}

// Export the class for use as a module
module.exports = DailyGammonRetriever;

// Run main function if this file is executed directly
if (require.main === module) {
    main();
} 