/**
 * Jira Fetcher - Retrieves sprint data, tickets, velocity, and team info from Jira
 */

const PROJECTS = [
  { key: 'DATAG', board: 2525 },
  { key: 'SAASD8NG', board: 1082 },
  { key: 'SAASFD', board: 2565 }
];

export class JiraFetcher {
  constructor(mcpClient, cloudId) {
    this.mcp = mcpClient;
    this.cloudId = cloudId;
  }

  static async create(mcpClient) {
    const result = await mcpClient.call('getAccessibleAtlassianResources', {});
    const data = mcpClient.extractJSON(result);
    let cloudId = null;
    if (Array.isArray(data)) {
      for (const r of data) {
        if (r.url && r.url.includes('sailpoint')) {
          cloudId = r.id;
          break;
        }
      }
    }
    if (!cloudId) throw new Error('Could not find SailPoint Atlassian cloud ID');
    return new JiraFetcher(mcpClient, cloudId);
  }

  async searchIssues(jql, maxResults = 50) {
    const result = await this.mcp.call('searchJiraIssuesUsingJql', {
      cloudId: this.cloudId,
      jql,
      maxResults
    });
    return this.mcp.extractJSON(result);
  }

  async getIssue(issueKey) {
    const result = await this.mcp.call('getJiraIssue', {
      cloudId: this.cloudId,
      issueIdOrKey: issueKey
    });
    return this.mcp.extractJSON(result);
  }

  /**
   * Fetch current active sprint tickets for all projects
   */
  async fetchActiveSprintTickets() {
    const allTickets = {};

    for (const project of PROJECTS) {
      process.stderr.write(`  Fetching active sprint for ${project.key}...\n`);
      try {
        const data = await this.searchIssues(
          `project = ${project.key} AND sprint in openSprints() ORDER BY priority ASC, created DESC`,
          100
        );
        const tickets = this._parseSearchResults(data);
        allTickets[project.key] = tickets;
        process.stderr.write(`    Found ${tickets.length} tickets in active sprint\n`);
      } catch (e) {
        process.stderr.write(`    Error fetching ${project.key}: ${e.message}\n`);
        allTickets[project.key] = [];
      }
    }
    return allTickets;
  }

  /**
   * Fetch backlog items (not in any sprint)
   */
  async fetchBacklog() {
    const backlog = {};

    for (const project of PROJECTS) {
      process.stderr.write(`  Fetching backlog for ${project.key}...\n`);
      try {
        const data = await this.searchIssues(
          `project = ${project.key} AND sprint is EMPTY AND status != Done AND type in (Story, Task, Bug) ORDER BY priority ASC, created DESC`,
          50
        );
        const tickets = this._parseSearchResults(data);
        backlog[project.key] = tickets;
        process.stderr.write(`    Found ${tickets.length} backlog items\n`);
      } catch (e) {
        process.stderr.write(`    Error: ${e.message}\n`);
        backlog[project.key] = [];
      }
    }
    return backlog;
  }

  /**
   * Fetch recently completed sprints for velocity calculation
   */
  async fetchCompletedSprintData(numSprints = 3) {
    const velocityData = {};

    for (const project of PROJECTS) {
      process.stderr.write(`  Fetching completed sprints for ${project.key}...\n`);
      const sprintData = [];

      for (let i = 1; i <= numSprints; i++) {
        try {
          const data = await this.searchIssues(
            `project = ${project.key} AND sprint in closedSprints() AND status = Done AND resolved >= -${i * 14}d AND resolved < -${(i - 1) * 14}d ORDER BY resolved DESC`,
            100
          );
          const tickets = this._parseSearchResults(data);
          sprintData.push({
            sprintIndex: i,
            ticketsCompleted: tickets.length,
            tickets
          });
          process.stderr.write(`    Sprint -${i}: ${tickets.length} tickets completed\n`);
        } catch (e) {
          process.stderr.write(`    Error: ${e.message}\n`);
          sprintData.push({ sprintIndex: i, ticketsCompleted: 0, tickets: [] });
        }
      }
      velocityData[project.key] = sprintData;
    }
    return velocityData;
  }

  /**
   * Fetch carry-over items (items from previous sprint still not done)
   */
  async fetchCarryOver() {
    const carryOver = {};

    for (const project of PROJECTS) {
      process.stderr.write(`  Fetching carry-over for ${project.key}...\n`);
      try {
        const data = await this.searchIssues(
          `project = ${project.key} AND sprint in openSprints() AND status != Done AND status != Closed AND updated < -7d ORDER BY priority ASC`,
          50
        );
        const tickets = this._parseSearchResults(data);
        carryOver[project.key] = tickets;
        process.stderr.write(`    Found ${tickets.length} carry-over items\n`);
      } catch (e) {
        process.stderr.write(`    Error: ${e.message}\n`);
        carryOver[project.key] = [];
      }
    }
    return carryOver;
  }

  /**
   * Fetch detailed info for specific tickets (includes assignee)
   * Merges with base data from search results when available
   */
  async fetchTicketDetails(ticketKeys, baseTickets = []) {
    const baseMap = new Map();
    for (const t of baseTickets) {
      if (t.key) baseMap.set(t.key, t);
    }

    const details = [];
    for (const key of ticketKeys) {
      try {
        const data = await this.getIssue(key);
        const parsed = this._parseIssueDetail(key, data);
        // Merge with base data from search
        const base = baseMap.get(key) || {};
        const mergedSP = parsed.storyPoints || base.storyPoints || 0;
        details.push({
          ...base,
          ...parsed,
          summary: parsed.summary || base.summary || '',
          priority: parsed.priority || base.priority || '',
          status: parsed.status || base.status || '',
          type: parsed.type || base.type || '',
          storyPoints: this._extractStoryPoints(mergedSP)
        });
      } catch (e) {
        // Fall back to base search data if detail fetch fails
        const base = baseMap.get(key);
        if (base) {
          details.push({ ...base, assignee: 'Unassigned' });
        } else {
          details.push({ key, error: e.message, assignee: 'Unassigned' });
        }
      }
    }
    return details;
  }

  /**
   * Fetch team members with active assignments
   * Samples tickets from each project and fetches details to find assignees
   */
  async fetchTeamMembers() {
    const members = new Map();

    for (const project of PROJECTS) {
      process.stderr.write(`  Discovering team members for ${project.key}...\n`);
      try {
        const data = await this.searchIssues(
          `project = ${project.key} AND assignee is not EMPTY AND status != Done AND sprint in openSprints() ORDER BY assignee`,
          30
        );
        const tickets = this._parseSearchResults(data);
        const sampleKeys = tickets.slice(0, 15).map(t => t.key);
        const details = await this.fetchTicketDetails(sampleKeys, tickets);

        for (const d of details) {
          if (d.assignee && d.assignee !== 'Unassigned') {
            if (!members.has(d.assignee)) {
              members.set(d.assignee, { name: d.assignee, projects: new Set(), ticketCount: 0 });
            }
            const m = members.get(d.assignee);
            m.projects.add(project.key);
            m.ticketCount++;
          }
        }
        process.stderr.write(`    Found ${members.size} unique members so far\n`);
      } catch (e) {
        process.stderr.write(`    Error fetching members for ${project.key}: ${e.message}\n`);
      }
    }

    return Array.from(members.values()).map(m => ({
      ...m,
      projects: Array.from(m.projects)
    }));
  }

  _parseSearchResults(data) {
    const tickets = [];
    if (!data) return tickets;

    if (typeof data === 'string') {
      const lines = data.split('\n');
      for (const line of lines) {
        const match = line.match(/^[-*]\s+\[?([A-Z]+-\d+)\]?[:\s]+(.+)/);
        if (match) {
          tickets.push({
            key: match[1],
            summary: match[2].trim(),
            raw: line
          });
        }
        const altMatch = line.match(/\*\*([A-Z]+-\d+)\*\*[:\s]+(.+)/);
        if (altMatch && !match) {
          tickets.push({
            key: altMatch[1],
            summary: altMatch[2].trim(),
            raw: line
          });
        }
      }
      // Also try to extract from summary block
      if (tickets.length === 0) {
        const keyMatches = data.matchAll(/([A-Z]+-\d+)/g);
        for (const m of keyMatches) {
          if (!tickets.find(t => t.key === m[1])) {
            tickets.push({ key: m[1], summary: '', raw: '' });
          }
        }
      }
    } else if (data.issues) {
      for (const issue of data.issues) {
        const rawSP = issue.fields?.customfield_10016 ?? issue.fields?.story_points ?? 0;
        tickets.push({
          key: issue.key,
          summary: issue.fields?.summary || '',
          type: issue.fields?.issuetype?.name || '',
          priority: issue.fields?.priority?.name || '',
          status: issue.fields?.status?.name || '',
          storyPoints: this._extractStoryPoints(rawSP)
        });
      }
    }

    return tickets;
  }

  _parseIssueDetail(key, data) {
    if (!data) return { key, assignee: 'Unassigned' };

    // Handle JSON format (standard Jira API response)
    if (typeof data === 'object' && data.fields) {
      const rawSP = data.fields.customfield_10016 ?? data.fields.story_points ?? 0;
      return {
        key: data.key || key,
        summary: data.fields.summary || '',
        assignee: data.fields.assignee?.displayName || data.fields.assignee?.emailAddress || 'Unassigned',
        status: data.fields.status?.name || '',
        priority: data.fields.priority?.name || '',
        type: data.fields.issuetype?.name || '',
        storyPoints: this._extractStoryPoints(rawSP),
        labels: data.fields.labels || [],
        created: data.fields.created || '',
        updated: data.fields.updated || ''
      };
    }

    // Handle text/markdown format
    if (typeof data === 'string') {
      const detail = { key };

      const extractField = (patterns) => {
        for (const pattern of patterns) {
          const match = data.match(pattern);
          if (match) return match[1].trim();
        }
        return null;
      };

      detail.assignee = extractField([
        /\*\*Assignee\*\*[:\s]+([^\n*|]+)/i,
        /Assignee[:\s]+([^\n,|]+)/i,
        /"assignee"\s*:\s*\{[^}]*"displayName"\s*:\s*"([^"]+)"/
      ]) || 'Unassigned';

      detail.summary = extractField([
        /\*\*Summary\*\*[:\s]+([^\n]+)/i,
        /Summary[:\s]+([^\n]+)/i,
        /"summary"\s*:\s*"([^"]+)"/
      ]) || '';

      detail.status = extractField([
        /\*\*Status\*\*[:\s]+([^\n*|]+)/i,
        /Status[:\s]+([^\n,|]+)/i,
        /"status"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/
      ]) || '';

      detail.priority = extractField([
        /\*\*Priority\*\*[:\s]+([^\n*|]+)/i,
        /Priority[:\s]+([^\n,|]+)/i,
        /"priority"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/
      ]) || '';

      detail.type = extractField([
        /\*\*(?:Issue\s*)?Type\*\*[:\s]+([^\n*|]+)/i,
        /(?:Issue\s*)?Type[:\s]+([^\n,|]+)/i,
        /"issuetype"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/
      ]) || '';

      const spStr = extractField([
        /\*\*Story\s*Points?\*\*[:\s]+(\d+)/i,
        /Story\s*Points?[:\s]+(\d+)/i,
        /"customfield_10016"\s*:\s*(\d+)/
      ]);
      detail.storyPoints = spStr ? parseInt(spStr) : 0;

      return detail;
    }

    // Handle nested object (e.g. wrapped in content)
    if (typeof data === 'object') {
      const rawSP = data.customfield_10016 ?? data.storyPoints ?? 0;
      return {
        key,
        summary: data.summary || '',
        assignee: data.assignee?.displayName || data.assignee || 'Unassigned',
        status: data.status?.name || data.status || '',
        priority: data.priority?.name || data.priority || '',
        type: data.issuetype?.name || data.type || '',
        storyPoints: this._extractStoryPoints(rawSP)
      };
    }

    return { key, assignee: 'Unassigned' };
  }

  /**
   * Extract a numeric story point value from various Jira field formats.
   * The customfield_10016 can be: a number, an object {value: n}, an array, or null.
   */
  _extractStoryPoints(raw) {
    if (raw === null || raw === undefined) return 0;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const n = parseFloat(raw);
      return isNaN(n) ? 0 : n;
    }
    if (typeof raw === 'object') {
      if (Array.isArray(raw)) {
        // Some fields return array of sprint objects, not points
        return 0;
      }
      // Object with value property
      if (raw.value !== undefined) return this._extractStoryPoints(raw.value);
      if (raw.name !== undefined) return this._extractStoryPoints(raw.name);
      return 0;
    }
    return 0;
  }
}
