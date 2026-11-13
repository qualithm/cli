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

/** Accepts an invite by id; only the account whose email it names can. */
export const addTeamMember = defineTool({
  name: "add_team_member",
  description:
    "Accept an invite by id. Only the account whose email the invite names can accept it.",
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

/** Lists pending invites to a team. */
export const listTeamInvites = defineTool({
  name: "list_team_invites",
  description: "List pending invites to a team.",
  mutating: false,
  input: { teamId: teamId("id of the team to list invites for"), ...pageInput },
  run: async (session, input) => {
    const { data } = await session.client.api(InvitesApi).listTeamInvites(input)
    return data
  }
})

const inviteToken = z
  .string()
  .min(1)
  .describe("the token from the invite link, the part after /invites/")

/** Invites email addresses to a team with one role. */
export const createTeamInvite = defineTool({
  name: "create_team_invite",
  description:
    "Invite email addresses to a team with one role. Each address gets a result: sent, already_member, or already_invited (resend that one instead). Each link expires after 7 days, and the team can send a limited number of invite emails per hour.",
  mutating: true,
  input: {
    teamId: teamId("id of the team to invite into"),
    emails: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe("addresses to invite, with or without an account; up to 20"),
    role: role.describe("role every invite grants: owner, manager, or viewer"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const { data } = await session.client.api(InvitesApi).createTeamInvite({
      teamId: input.teamId,
      createTeamInviteRequest: { emails: input.emails, role: input.role }
    })
    return data
  }
})

/** Mails a pending invite again with a new link. */
export const resendTeamInvite = defineTool({
  name: "resend_team_invite",
  description:
    "Mail a pending invite again with a new link that expires after 7 days; the old link stops working.",
  mutating: true,
  input: {
    teamId: teamId("id of the team"),
    inviteId: z.string().min(1).describe("id of the invite to resend"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const { data } = await session.client
      .api(InvitesApi)
      .resendTeamInvite({ teamId: input.teamId, inviteId: input.inviteId })
    return data
  }
})

/** Withdraws a pending invite. */
export const revokeTeamInvite = defineTool({
  name: "revoke_team_invite",
  description: "Withdraw a pending team invite; its link stops working.",
  mutating: true,
  input: {
    teamId: teamId("id of the team"),
    inviteId: z.string().min(1).describe("id of the invite to withdraw"),
    ...dryRunInput
  },
  run: async (session, input) => {
    await session.client
      .api(InvitesApi)
      .deleteTeamInvite({ teamId: input.teamId, inviteId: input.inviteId })
    return undefined
  }
})

/** Reads the invite a link token names. */
export const lookupInvite = defineTool({
  name: "lookup_invite",
  description:
    "Read the invite an invite link names: the team, role, inviter and expiry, and forCaller, whether the signed-in account may accept it.",
  mutating: false,
  input: { token: inviteToken },
  run: async (session, input) => {
    const { data } = await session.client
      .api(InvitesApi)
      .lookupInvite({ acceptInviteRequest: { token: input.token } })
    return data
  }
})

/** Accepts the invite a link token names. */
export const acceptInvite = defineTool({
  name: "accept_invite",
  description:
    "Accept the invite an invite link names, joining its team. Only the account whose email the invite names can accept it.",
  mutating: true,
  input: { token: inviteToken, ...dryRunInput },
  run: async (session, input) => {
    const { data } = await session.client
      .api(InvitesApi)
      .acceptInvite({ acceptInviteRequest: { token: input.token } })
    return data
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
  resendTeamInvite,
  revokeTeamInvite,
  lookupInvite,
  acceptInvite
]
