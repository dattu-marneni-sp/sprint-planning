/**
 * Velocity & Capacity Analyzer
 * Calculates team velocity from historical sprint data and assesses capacity
 */

export class VelocityAnalyzer {
  constructor() {
    this.sprintLengthDays = 14; // 2-week sprints
    this.defaultCapacityPerPerson = 10; // story points per sprint
  }

  /**
   * Calculate average velocity per project from completed sprint data
   */
  calculateVelocity(completedSprintData) {
    const velocity = {};

    for (const [project, sprints] of Object.entries(completedSprintData)) {
      const sprintCounts = sprints.map(s => s.ticketsCompleted);
      const totalTickets = sprintCounts.reduce((a, b) => a + b, 0);
      const avgTickets = sprintCounts.length > 0 ? totalTickets / sprintCounts.length : 0;

      // Calculate story points if available
      let totalPoints = 0;
      let pointSprints = 0;
      for (const sprint of sprints) {
        const sprintPoints = sprint.tickets.reduce((sum, t) => sum + (t.storyPoints || 0), 0);
        if (sprintPoints > 0) {
          totalPoints += sprintPoints;
          pointSprints++;
        }
      }
      const avgPoints = pointSprints > 0 ? totalPoints / pointSprints : 0;

      // Velocity trend (improving, stable, declining)
      let trend = 'stable';
      if (sprintCounts.length >= 2) {
        const recent = sprintCounts[0];
        const older = sprintCounts[sprintCounts.length - 1];
        if (recent > older * 1.15) trend = 'improving';
        else if (recent < older * 0.85) trend = 'declining';
      }

      velocity[project] = {
        avgTicketsPerSprint: Math.round(avgTickets * 10) / 10,
        avgPointsPerSprint: Math.round(avgPoints * 10) / 10,
        trend,
        sprintHistory: sprintCounts,
        totalSprintsAnalyzed: sprints.length
      };
    }

    return velocity;
  }

  /**
   * Assess team capacity for next sprint
   */
  assessCapacity(teamMembers, availabilityInfo) {
    const capacity = {
      totalMembers: teamMembers.length,
      members: [],
      totalCapacity: 0,
      oooMembers: [],
      reducedCapacity: false
    };

    // Parse OOO info from Confluence
    const oooNames = new Set();
    for (const info of availabilityInfo) {
      const content = info.content.toLowerCase();
      for (const member of teamMembers) {
        const nameParts = member.name.toLowerCase().split(/\s+/);
        for (const part of nameParts) {
          if (part.length > 2 && content.includes(part)) {
            if (content.includes('ooo') || content.includes('out of office') ||
                content.includes('vacation') || content.includes('holiday')) {
              oooNames.add(member.name);
            }
          }
        }
      }
    }

    for (const member of teamMembers) {
      const isOOO = oooNames.has(member.name);
      const availabilityFactor = isOOO ? 0.0 : 1.0;
      const memberCapacity = Math.round(this.defaultCapacityPerPerson * availabilityFactor);

      capacity.members.push({
        name: member.name,
        projects: member.projects,
        currentTickets: member.ticketCount,
        isOOO,
        availabilityFactor,
        estimatedCapacity: memberCapacity
      });

      if (isOOO) {
        capacity.oooMembers.push(member.name);
      }
      capacity.totalCapacity += memberCapacity;
    }

    capacity.reducedCapacity = capacity.oooMembers.length > 0;

    return capacity;
  }

  /**
   * Generate capacity summary and recommendations
   */
  generateCapacitySummary(velocity, capacity) {
    const summary = {
      teamSize: capacity.totalMembers,
      availableMembers: capacity.totalMembers - capacity.oooMembers.length,
      totalCapacity: capacity.totalCapacity,
      oooMembers: capacity.oooMembers,
      projectVelocity: {},
      recommendation: ''
    };

    // Aggregate velocity across projects
    let totalAvgTickets = 0;
    for (const [project, v] of Object.entries(velocity)) {
      summary.projectVelocity[project] = {
        avgTickets: v.avgTicketsPerSprint,
        avgPoints: v.avgPointsPerSprint,
        trend: v.trend
      };
      totalAvgTickets += v.avgTicketsPerSprint;
    }

    // Generate recommendation
    const capacityRatio = capacity.totalCapacity / (this.defaultCapacityPerPerson * capacity.totalMembers || 1);

    if (capacityRatio < 0.7) {
      summary.recommendation = `Reduced capacity (${Math.round(capacityRatio * 100)}%). Plan fewer tickets than average velocity. Suggest ${Math.round(totalAvgTickets * capacityRatio)} tickets max.`;
    } else if (capacityRatio >= 0.7 && capacityRatio <= 1.0) {
      summary.recommendation = `Normal capacity (${Math.round(capacityRatio * 100)}%). Plan close to average velocity: ~${Math.round(totalAvgTickets)} tickets.`;
    } else {
      summary.recommendation = `Full capacity available. Target average velocity: ~${Math.round(totalAvgTickets)} tickets.`;
    }

    return summary;
  }
}
