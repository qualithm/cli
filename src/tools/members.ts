import { InvitesApi, MemberRole, MembersApi } from "@qualithm/platform"
import { z } from "zod"

import { defineTool, dryRunInput, pageInput, type Tool } from "./tool.ts"

const role = z.enum(Object.values(MemberRole) as [MemberRole, ...MemberRole[]])

const teamId = (description: string): z.ZodString => z.string().min(1).describe(description)

/** Lists the active members of a team. */
export const listTeamMembers = defineTool({
  name: "list_team_members",
  description: "List the active members of a team.",
  mutating: false,
  input: { teamId: teamId("id of the team to list members for"), ...pageInput },
  run: async (session, input) => {
    const { data } = await session.client.api(MembersApi).listTeamMembers(input)
    return data
  }
})

/** Accepts the caller's own invitation to a team. */
export const addTeamMember = defineTool({
  name: "add_team_member",
  description: "Accept the caller's invitation to a team, activating their membership.",
  mutating: true,
  input: {
    teamId: teamId("id of the team the invite belongs to"),
    inviteId: z.string().min(1).describe("id of the invite being accepted"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const { data } = await session.client.api(MembersApi).createTeamMember({
      teamId: input.teamId,
      createTeamMemberRequest: { inviteId: input.inviteId }
    })
    return data
  }
})

/** Fetches one team member. */
export const getTeamMember = defineTool({
  name: "get_team_member",
  description: "Fetch a single team member by id.",
  mutating: false,
  input: {
    teamId: teamId("id of the team"),
    memberId: z.string().min(1).describe("id of the member to fetch")
  },
  run: async (session, input) => {
    const { data } = await session.client.api(MembersApi).getTeamMember(input)
    return data
  }
})

/** Changes a member's role. */
export const updateTeamMember = defineTool({
  name: "update_team_member",
  description: "Change a team member's role.",
  mutating: true,
  input: {
    teamId: teamId("id of the team"),
    memberId: z.string().min(1).describe("id of the member to update"),
    role: role.describe("new role: owner, manager, or viewer"),
    ...dryRunInput
  },
  run: async (session, input) => {
    await session.client.api(MembersApi).updateTeamMember({
      teamId: input.teamId,
      memberId: input.memberId,
      updateTeamMemberRequest: { role: input.role }
    })
    return undefined
  }
})

/** Removes a member from a team. */
export const removeTeamMember = defineTool({
  name: "remove_team_member",
  description: "Remove a member from a team.",
  mutating: true,
  input: {
    teamId: teamId("id of the team"),
    memberId: z.string().min(1).describe("id of the member to remove"),
    ...dryRunInput
  },
  run: async (session, input) => {
    await session.client
      .api(MembersApi)
      .deleteTeamMember({ teamId: input.teamId, memberId: input.memberId })
    return undefined
  }
})

/** Lists pending invitations to a team. */
export const listTeamInvites = defineTool({
  name: "list_team_invites",
  description: "List pending invitations to a team.",
  mutating: false,
  input: { teamId: teamId("id of the team to list invites for"), ...pageInput },
  run: async (session, input) => {
    const { data } = await session.client.api(InvitesApi).listTeamInvites(input)
    return data
  }
})

/** Invites an account to a team by email. */
export const createTeamInvite = defineTool({
  name: "create_team_invite",
  description: "Invite an account to a team by email.",
  mutating: true,
  input: {
    teamId: teamId("id of the team to invite into"),
    email: z.string().min(1).describe("email address of the account to invite"),
    role: role.describe("role the invite grants: owner, manager, or viewer"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const { data } = await session.client.api(InvitesApi).createTeamInvite({
      teamId: input.teamId,
      createTeamInviteRequest: { email: input.email, role: input.role }
    })
    return data
  }
})

/** Revokes a pending invitation. */
export const revokeTeamInvite = defineTool({
  name: "revoke_team_invite",
  description: "Revoke a pending team invitation.",
  mutating: true,
  input: {
    teamId: teamId("id of the team"),
    inviteId: z.string().min(1).describe("id of the invite to revoke"),
    ...dryRunInput
  },
  run: async (session, input) => {
    await session.client
      .api(InvitesApi)
      .deleteTeamInvite({ teamId: input.teamId, inviteId: input.inviteId })
    return undefined
  }
})

/** Member and invite tools: who belongs to a team and who's invited. */
export const memberTools: readonly Tool[] = [
  listTeamMembers,
  addTeamMember,
  getTeamMember,
  updateTeamMember,
  removeTeamMember,
  listTeamInvites,
  createTeamInvite,
  revokeTeamInvite
]
