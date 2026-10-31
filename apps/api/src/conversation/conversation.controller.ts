import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
  CreateAgentMessageSchema,
  CreateReplySchema,
  type CreateAgentMessageInput,
  type MessageDto,
} from '@kvitok/shared';
import type { z } from 'zod';
import { CurrentAuth } from '../auth/decorators';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { ConversationService } from './conversation.service';

@Controller('workspaces/:workspaceId/tickets/:ticketId')
@UseGuards(WorkspaceGuard)
@RequireRole('operator')
export class ConversationController {
  constructor(private readonly conversation: ConversationService) {}

  @Post('agent/messages')
  addAgentMessage(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(CreateAgentMessageSchema)) body: CreateAgentMessageInput,
    @CurrentAuth() auth: AuthContext,
  ): Promise<MessageDto> {
    return this.conversation.addAgentMessage(workspaceId, ticketId, auth.user.id, body);
  }

  @Post('replies')
  reply(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(CreateReplySchema)) body: z.output<typeof CreateReplySchema>,
    @CurrentAuth() auth: AuthContext,
  ): Promise<MessageDto> {
    return this.conversation.reply(workspaceId, ticketId, auth.user.id, body);
  }

  @Post('messages/:messageId/cancel')
  cancel(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Param('messageId') messageId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<MessageDto> {
    return this.conversation.cancelReply(workspaceId, ticketId, messageId, auth.user.id);
  }
}
