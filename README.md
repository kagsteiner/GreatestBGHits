# DailyGammon Match Retriever

A Node.js script to automatically login to DailyGammon.com and retrieve export links for finished backgammon matches.

## Features

- Simulates login to DailyGammon.com using username/password
- Retrieves finished matches within a specified time range
- Extracts export links for match analysis
- Handles session cookies and HTTP authentication
- Configurable parameters for days and user ID

## Installation

1. Install dependencies:
```bash
npm install
```

## Usage

### Environment Variables

You can set your DailyGammon credentials in multiple ways:

#### Option 1: Using .env file (Recommended)

1. Create a `.env` file in the project root:
```bash
# Copy the example file
cp env.example .env
```

2. Edit the `.env` file with your credentials:
```
DG_USERNAME=your_dailygammon_username
DG_PASSWORD=your_dailygammon_password
DG_DAYS=30
DG_USER_ID=36594
```

3. Run the script:
```bash
node index.js
```

#### Option 2: Environment Variables

Set your DailyGammon credentials as environment variables:

```bash
export DG_USERNAME="your_username"
export DG_PASSWORD="your_password"
export DG_DAYS=30  # Optional: days to look back (default: 30)
export DG_USER_ID=36594  # Optional: user ID (default: 36594)
```

### Run the Script

```bash
# Using .env file or environment variables
node index.js

# Or set variables inline (overrides .env)
DG_USERNAME=myusername DG_PASSWORD=mypassword node index.js
```

### Using as a Module

```javascript
const DailyGammonRetriever = require('./index.js');

async function getMatches() {
    const retriever = new DailyGammonRetriever();
    const exportLinks = await retriever.getFinishedMatches('username', 'password', 30, '36594');
    console.log('Export links:', exportLinks);
}
```

## API

### DailyGammonRetriever

#### Methods

- `login(username, password)` - Login to DailyGammon
- `getFinishedMatches(username, password, days, userId)` - Get export links for finished matches
- `parseExportLinks(html)` - Parse HTML to extract export links
- `getFullExportUrls(exportHrefs)` - Convert relative URLs to full URLs

#### Parameters

- `username` (string) - DailyGammon username
- `password` (string) - DailyGammon password
- `days` (number) - Number of days to look back (default: 30)
- `userId` (string) - DailyGammon user ID (default: '36594')

## Example Output

```
Attempting to login as myusername...
Login successful!
Retrieving matches for the last 30 days...
Found 5 export links

Export links found:
1. http://dailygammon.com/bg/export/5151240
2. http://dailygammon.com/bg/export/5151241
3. http://dailygammon.com/bg/export/5151242
4. http://dailygammon.com/bg/export/5151243
5. http://dailygammon.com/bg/export/5151244
```

## Technical Details

- Uses axios for HTTP requests with session cookie management
- Uses cheerio for HTML parsing
- Handles the old-fashioned HTML form-based authentication
- Supports the URL pattern: `/bg/user/{userId}?days_to_view={days}&active=1&finished=1`
- Extracts export links matching pattern: `/bg/export/{matchId}`

## Security Note

This script is designed for the simple HTTP-based DailyGammon site without modern security measures. It handles basic session cookies and form-based authentication as described in the original requirements. 