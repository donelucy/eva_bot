import { nanoid } from "nanoid";
import type { Config, SwarmAgent, SwarmTask, ToolContext } from "../types.js";
import { LLMClient, type ChatMessage } from "./llm.js";
import { logger } from "../utils/logger.js";

/**
 * Agent Swarm — spin up a team of specialized sub-agents that collaborate
 * on a complex task, coordinated by an orchestrator.
 *
 * Usage: Give the orchestrator a high-level objective and a list of agent roles.
 * Each agent works in parallel, then results are synthesized.
 */
export class SwarmOrchestrator {
  private llm: LLMClient;

  constructor(private config: Config) {
    this.llm = new LLMClient(config);
  }

  /**
   * Run a swarm task — assign roles, execute in parallel, synthesize
   */
  async run(
    objective: string,
    userId: string,
    channel: string,
    customAgents?: Partial<SwarmAgent>[]
  ): Promise<string> {
    const taskId = nanoid();
    logger.info(`[Swarm] Starting task ${taskId}: ${objective.slice(0, 60)}...`);

    // Step 1: Orchestrator decomposes objective into sub-tasks
    const agents = customAgents?.length
      ? this.buildCustomAgents(customAgents)
      : await this.decomposeObjective(objective);

    if (agents.length === 0) {
      return "Could not decompose the objective into sub-tasks.";
    }

    logger.info(`[Swarm] Spawned ${agents.length} agents: ${agents.map((a) => a.role).join(", ")}`);

    // Step 2: Execute all agents in parallel with timeout protection
    const AGENT_TIMEOUT = 60000; // 60 seconds per agent
    const results = await Promise.allSettled(
      agents.map((agent) => 
        Promise.race([
          this.runAgent(agent, objective),
          new Promise<string>((_, reject) => 
            setTimeout(() => reject(new Error("Agent timeout")), AGENT_TIMEOUT)
          )
        ])
      )
    );

    // Step 3: Collect results
    const agentResults: Record<string, string> = {};
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]!;
      const result = results[i];
      if (result?.status === "fulfilled") {
        agentResults[agent.role] = result.value;
      } else if (result?.status === "rejected") {
        const error = result.reason as Error;
        const errorMsg = error.message === "Agent timeout" 
          ? "Agent timed out after 60 seconds" 
          : `Error: ${error.message}`;
        agentResults[agent.role] = errorMsg;
        logger.warn(`[Swarm] Agent "${agent.role}" failed: ${errorMsg}`);
      } else {
        agentResults[agent.role] = "Error: unknown";
      }
    }

    // Step 4: Orchestrator synthesizes all results
    const synthesis = await this.synthesize(objective, agentResults);

    logger.info(`[Swarm] Task ${taskId} complete`);
    return synthesis;
  }

  /**
   * Ask the LLM to decompose the objective into specialized agents
   */
  private async decomposeObjective(objective: string): Promise<SwarmAgent[]> {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: `Decompose this task into 2-4 specialized sub-agents. For each agent, provide:
- role: short name (e.g. "researcher", "analyst", "writer")
- systemPrompt: instructions for that agent's specific job

Task: ${objective}

Respond ONLY with a JSON array like:
[{"role": "researcher", "systemPrompt": "You are a research specialist..."},...]`,
      },
    ];

    try {
      const resp = await this.llm.chat(messages, { maxTokens: 1000 });
      const jsonMatch = resp.content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON found in response");

      const parsed = JSON.parse(jsonMatch[0]) as Array<{ role: string; systemPrompt: string }>;
      return parsed.map((a) => ({
        id: nanoid(),
        name: a.role,
        role: a.role,
        systemPrompt: a.systemPrompt,
        model: this.config.defaultModel,
        tools: [],
      }));
    } catch (err) {
      logger.error("[Swarm] Failed to decompose objective:", err);
      // Fallback: single agent
      return [
        {
          id: nanoid(),
          name: "general",
          role: "general",
          systemPrompt: "You are a helpful assistant. Complete the assigned task thoroughly.",
          model: this.config.defaultModel,
          tools: [],
        },
      ];
    }
  }

  private buildCustomAgents(partial: Partial<SwarmAgent>[]): SwarmAgent[] {
    return partial.map((a) => ({
      id: a.id ?? nanoid(),
      name: a.name ?? a.role ?? "agent",
      role: a.role ?? "general",
      systemPrompt: a.systemPrompt ?? "You are a helpful assistant.",
      model: a.model ?? this.config.defaultModel,
      tools: a.tools ?? [],
    }));
  }

  /**
   * Run a single agent with its specialized system prompt
   */
  private async runAgent(agent: SwarmAgent, objective: string): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: `Main objective: ${objective}\n\nYour role as ${agent.role}: Complete your part of this task as thoroughly as possible.`,
      },
    ];

    const resp = await this.llm.chat(messages, {
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      maxTokens: 2048,
    });

    logger.debug(`[Swarm] Agent "${agent.role}" complete (${resp.usage?.output ?? "?"} tokens)`);
    return resp.content;
  }

  /**
   * Synthesize all agent results into a final coherent response
   */
  private async synthesize(objective: string, results: Record<string, string>): Promise<string> {
    const resultsSummary = Object.entries(results)
      .map(([role, result]) => `## ${role.toUpperCase()}\n${result}`)
      .join("\n\n---\n\n");

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: `Original objective: ${objective}

The following specialized agents completed parts of this task:

${resultsSummary}

Synthesize these results into a single, coherent, well-organized response that fully addresses the original objective. Remove redundancy and ensure the output is polished.`,
      },
    ];

    const resp = await this.llm.chat(messages, {
      systemPrompt: "You are an expert synthesizer. Combine multiple agents' outputs into one excellent response.",
      maxTokens: 4096,
    });

    return resp.content;
  }
}

// ── Swarm Tool (registered as a tool in the agent loop) ──────────────────────

export function makeSwarmTool(config: Config) {
  const orchestrator = new SwarmOrchestrator(config);

  return {
    name: "agent_swarm",
    description:
      "Delegate a complex task to a team of specialized AI agents working in parallel. Use for tasks that benefit from multiple perspectives: research + analysis + writing, multi-step planning, etc.",
    parameters: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description: "The high-level objective for the swarm to accomplish",
        },
        agents: {
          type: "array",
          description:
            "Optional: define custom agents. Each has role (string) and systemPrompt (string). If not provided, the orchestrator auto-decomposes.",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              systemPrompt: { type: "string" },
            },
          },
        },
      },
      required: ["objective"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const objective = args["objective"] as string;
      const customAgents = args["agents"] as Partial<SwarmAgent>[] | undefined;

      return orchestrator.run(objective, ctx.userId, ctx.channel, customAgents);
    },
  };
}
