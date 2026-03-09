'use strict';

const DailyGammonRetriever = require('../DailyGammonRetriever');

const MATCHES_PAGE_HTML = `
<TABLE CELLSPACING=3>
<TR>
<TH align=left>#</TH><TH align=left>Event</TH>
<TH>Length</TH><TH>Opponent</TH>
</TR>
<TR>
<TD>1. </TD>
<TD><A HREF=/bg/event/106569>The Marathon #4069</A></TD>
<TD align=center>21</TD>
<TD ALIGN=CENTER><A href=/bg/user/23706>yopplat</A></TD>
<TD><A href=/bg/game/5150806/1/list>Review</A></TD>
<TD><A href=/bg/export/5150806>Export</A></TD>
</TR>
<TR>
<TD>2. </TD>
<TD><A HREF=/bg/event/109832>ANTI-Backgammon #123</A></TD>
<TD align=center>5</TD>
<TD ALIGN=CENTER><A href=/bg/user/99999>opponent</A></TD>
<TD><A href=/bg/game/5150900/0/list>Review</A></TD>
<TD><A href=/bg/export/5150900>Export</A></TD>
</TR>
<TR>
<TD>3. </TD>
<TD><A HREF=/bg/event/109836>Three Pointer #4482</A></TD>
<TD align=center>3</TD>
<TD ALIGN=CENTER><A href=/bg/user/40136>SaltySailor</A></TD>
<TD><A href=/bg/game/5169686/0/list>Review</A></TD>
<TD><A href=/bg/export/5169686>Export</A></TD>
</TR>
<TR>
<TD>4. </TD>
<TD><A HREF=/bg/event/108290>ANTI Backgammon Tournament</A></TD>
<TD align=center>7</TD>
<TD ALIGN=CENTER><A href=/bg/user/11111>player2</A></TD>
<TD><A href=/bg/export/5151000>Export</A></TD>
</TR>
<TR>
<TD>5. </TD>
<TD><A HREF=/bg/event/108291>ANTI-BACKGAMMON LADDER 2026</A></TD>
<TD align=center>5</TD>
<TD ALIGN=CENTER><A href=/bg/user/22222>ladderOpp</A></TD>
<TD><A href=/bg/export/5152000>Export</A></TD>
</TR>
</TABLE>
`;

describe('DailyGammonRetriever', () => {
    let retriever;

    beforeEach(() => {
        retriever = new DailyGammonRetriever();
    });

    describe('parseExportLinks()', () => {
        it('extracts export hrefs from matches page', () => {
            const links = retriever.parseExportLinks(MATCHES_PAGE_HTML);
            expect(links).toContain('/bg/export/5150806');
            expect(links).toContain('/bg/export/5169686');
        });

        it('includes regular matches with non-ANTI titles (e.g. The Marathon, Three Pointer)', () => {
            const links = retriever.parseExportLinks(MATCHES_PAGE_HTML);
            expect(links).toEqual(expect.arrayContaining([
                '/bg/export/5150806',  // The Marathon #4069
                '/bg/export/5169686'   // Three Pointer #4482
            ]));
            expect(links).toHaveLength(2);
        });

        it('excludes ANTI-Backgammon matches (hyphen)', () => {
            const links = retriever.parseExportLinks(MATCHES_PAGE_HTML);
            expect(links).not.toContain('/bg/export/5150900');
        });

        it('excludes ANTI Backgammon matches (space)', () => {
            const links = retriever.parseExportLinks(MATCHES_PAGE_HTML);
            expect(links).not.toContain('/bg/export/5151000');
        });

        it('excludes ANTI-BACKGAMMON matches (all caps, e.g. ladder)', () => {
            const links = retriever.parseExportLinks(MATCHES_PAGE_HTML);
            expect(links).not.toContain('/bg/export/5152000');
        });

        it('does not exclude matches with lowercase anti in event name', () => {
            const html = `
            <TABLE><TR>
            <TD><A HREF=/bg/event/1>anti-something else</A></TD>
            <TD><A href=/bg/export/12345>Export</A></TD>
            </TR></TABLE>`;
            const links = retriever.parseExportLinks(html);
            expect(links).toContain('/bg/export/12345');
        });

        it('includes exports when row has no event link (fallback)', () => {
            const html = `
            <TABLE><TR>
            <TD>1.</TD>
            <TD><A href=/bg/export/99999>Export</A></TD>
            </TR></TABLE>`;
            const links = retriever.parseExportLinks(html);
            expect(links).toContain('/bg/export/99999');
        });
    });
});
