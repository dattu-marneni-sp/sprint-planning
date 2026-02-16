/**
 * Confluence Fetcher - Retrieves sprint commitments, team capacity,
 * and planning docs from Confluence
 */

export class ConfluenceFetcher {
  constructor(mcpClient, cloudId) {
    this.mcp = mcpClient;
    this.cloudId = cloudId;
  }

  /**
   * Search for planning-related pages in the data space
   */
  async fetchPlanningPages() {
    process.stderr.write('  Searching Confluence for planning pages...\n');
    const pages = [];

    // Search data space for planning pages
    try {
      const result = await this.mcp.call('searchConfluenceUsingCql', {
        cloudId: this.cloudId,
        cql: 'type=page AND (title~"planning" OR title~"sprint" OR title~"capacity") AND space in (data, IPSTOOLS) ORDER BY lastmodified DESC',
        limit: 10
      });
      const data = this.mcp.extractJSON(result);
      if (data && data.results) {
        for (const r of data.results) {
          pages.push({
            id: r.content?.id || r.id,
            title: r.content?.title || r.title,
            space: r.content?.space?.key || r.resultGlobalContainer?.title || '',
            url: r.content?._links?.webui || '',
            lastModified: r.content?.history?.createdDate || ''
          });
        }
      }
    } catch (e) {
      process.stderr.write(`    CQL search error: ${e.message}\n`);
    }

    // Also use Rovo search for broader coverage
    try {
      const result = await this.mcp.call('search', {
        query: 'sprint planning team capacity OOO'
      });
      const data = this.mcp.extractJSON(result);
      if (data && data.results) {
        for (const r of data.results) {
          if (r.type === 'page' && !pages.find(p => p.id === r.id)) {
            pages.push({
              id: r.id,
              title: r.title,
              text: r.text || '',
              url: r.url || ''
            });
          }
        }
      }
    } catch (e) {
      process.stderr.write(`    Rovo search error: ${e.message}\n`);
    }

    process.stderr.write(`    Found ${pages.length} planning pages\n`);
    return pages;
  }

  /**
   * Fetch specific page content by ID
   */
  async fetchPageContent(pageId) {
    try {
      const result = await this.mcp.call('getConfluencePage', {
        cloudId: this.cloudId,
        pageId: String(pageId)
      });
      return this.mcp.extractText(result);
    } catch (e) {
      process.stderr.write(`    Error fetching page ${pageId}: ${e.message}\n`);
      return null;
    }
  }

  /**
   * Extract team commitments from Confluence pages
   */
  async fetchTeamCommitments() {
    process.stderr.write('  Fetching team commitments from Confluence...\n');
    const commitments = [];

    try {
      const result = await this.mcp.call('search', {
        query: 'sprint commitments priorities next sprint data platform'
      });
      const data = this.mcp.extractJSON(result);
      if (data && data.results) {
        for (const r of data.results) {
          if (r.text) {
            commitments.push({
              source: r.title || 'Unknown',
              url: r.url || '',
              content: r.text
            });
          }
        }
      }
    } catch (e) {
      process.stderr.write(`    Error: ${e.message}\n`);
    }

    return commitments;
  }

  /**
   * Search for OOO / availability info
   */
  async fetchAvailabilityInfo() {
    process.stderr.write('  Searching for team availability/OOO info...\n');
    const availability = [];

    try {
      const result = await this.mcp.call('search', {
        query: 'OOO out of office vacation holiday team availability'
      });
      const data = this.mcp.extractJSON(result);
      if (data && data.results) {
        for (const r of data.results) {
          if (r.text && (r.text.toLowerCase().includes('ooo') ||
              r.text.toLowerCase().includes('out of office') ||
              r.text.toLowerCase().includes('holiday') ||
              r.text.toLowerCase().includes('vacation'))) {
            availability.push({
              source: r.title || 'Unknown',
              url: r.url || '',
              content: r.text
            });
          }
        }
      }
    } catch (e) {
      process.stderr.write(`    Error: ${e.message}\n`);
    }

    return availability;
  }

  /**
   * Extract structured commitments from text
   */
  parseCommitmentsText(text) {
    const commitments = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Look for bullet points / numbered items that sound like commitments
      const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
      const numMatch = trimmed.match(/^\d+[.)]\s+(.+)/);

      if (bulletMatch || numMatch) {
        const content = (bulletMatch || numMatch)[1];
        // Classify priority from keywords
        let priority = 'medium';
        if (/\b(critical|blocker|urgent|P0|P1|high)\b/i.test(content)) priority = 'high';
        if (/\b(nice.to.have|low|optional|stretch|P3|P4)\b/i.test(content)) priority = 'low';

        commitments.push({ text: content, priority });
      }
    }

    return commitments;
  }
}
