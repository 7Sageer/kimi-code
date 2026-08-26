import { ScopeActivation, type ServicesAccessor } from '#/_base/di/instantiation';
import { IFlagService } from '#/app/flag/flag';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { SPINE_FLAG_ID } from './flag';
import {
  IAgentSpineService,
  SPINE_TOOL_CLOSE,
  SPINE_TOOL_NEXT,
  SPINE_TOOL_OPEN,
  SPINE_TOOL_TREE,
} from './spine';
import { AgentSpineService } from './spineService';
import { ISpineOpenTool } from './tools/spine-open';
import { SpineOpenTool } from './tools/spineOpenTool';
import { ISpineCloseTool } from './tools/spine-close';
import { SpineCloseTool } from './tools/spineCloseTool';
import { ISpineNextTool } from './tools/spine-next';
import { SpineNextTool } from './tools/spineNextTool';
import { ISpineTreeTool } from './tools/spine-tree';
import { SpineTreeTool } from './tools/spineTreeTool';

function spineToolWhen(accessor: ServicesAccessor): boolean {
  return (
    accessor.get(IFlagService).enabled(SPINE_FLAG_ID) &&
    accessor.get(IAgentScopeContext).agentId === MAIN_AGENT_ID
  );
}

export class SpineFeature extends Feature {
  static override readonly name = 'spine';

  constructor() {
    super();
    this.contributeAgentService(IAgentSpineService, AgentSpineService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeTool(ISpineOpenTool, SpineOpenTool, {
      name: SPINE_TOOL_OPEN,
      domain: 'spine',
      when: spineToolWhen,
    });
    this.contributeTool(ISpineCloseTool, SpineCloseTool, {
      name: SPINE_TOOL_CLOSE,
      domain: 'spine',
      when: spineToolWhen,
    });
    this.contributeTool(ISpineNextTool, SpineNextTool, {
      name: SPINE_TOOL_NEXT,
      domain: 'spine',
      when: spineToolWhen,
    });
    this.contributeTool(ISpineTreeTool, SpineTreeTool, {
      name: SPINE_TOOL_TREE,
      domain: 'spine',
      when: spineToolWhen,
    });
  }
}

registerFeature(SpineFeature);
