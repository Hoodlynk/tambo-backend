import config from '../config/config';
import Buddy from '../models/buddy.model';
import type { IBuddy } from '../models/buddy.model';
import User from '../models/user.model';
import type { IUser } from '../models/user.model';
import { AppError } from '../utils/appError';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import * as notifier from './notifier.service';
import type { BuddyInput } from '../validation/buddy.schema';

/**
 * Buddy relationships: owner -> a Tambo user who receives their theft alerts.
 * Consent is the buddy's in-app accept; there is no emailed consent link and
 * no public unauthenticated surface. Only 'active' buddies ever receive alerts.
 */

/** Shape returned to the OWNER (their outgoing invites/links). */
const toOwnerView = (
  link: IBuddy,
  buddyUser?: IUser | null,
): Record<string, unknown> => ({
  id: link._id.toString(),
  email: link.inviteEmail,
  // the buddy's real name only once they are a linked, named account
  name: buddyUser?.name ?? link.inviteName ?? null,
  status: link.status,
  invitedAt: link.invitedAt.toISOString(),
  ...(link.respondedAt ? { respondedAt: link.respondedAt.toISOString() } : {}),
});

/** Shape returned to the BUDDY (invitations addressed to them). */
const toInviteView = (
  link: IBuddy,
  ownerUser?: IUser | null,
): Record<string, unknown> => ({
  id: link._id.toString(),
  from: ownerUser ? { name: ownerUser.name } : null,
  status: link.status,
  invitedAt: link.invitedAt.toISOString(),
});

const sendInviteEmail = (
  to: string,
  ownerName: string,
  recipientIsUser: boolean,
): void => {
  const text = recipientIsUser
    ? [
        `Hi,`,
        '',
        `${ownerName} has added you as their Tambo buddy. If you accept, Tambo`,
        `will alert you if ${ownerName}'s phone is ever stolen, so you can help`,
        'them act quickly.',
        '',
        'Open the Tambo app to accept or decline - the choice is yours.',
      ].join('\n')
    : [
        `Hi,`,
        '',
        `${ownerName} wants you to be their Tambo buddy - the person Tambo`,
        `alerts if their phone is stolen. Tambo is a phone anti-theft app.`,
        '',
        'To accept, install Tambo and sign up with this email address; the',
        `invitation from ${ownerName} will be waiting for you in the app.`,
        '',
        'If you would rather not, simply ignore this email.',
      ].join('\n');

  notifier.sendEmail(
    { to, subject: `${ownerName} wants you as their Tambo buddy`, text },
    'buddy_invite',
  );
};

/**
 * Nominates a buddy by email. Resolves to a Tambo user when one exists (the
 * link binds immediately, still pending their accept); otherwise the link
 * waits and binds when that email signs up. Returns 'pending' either way, so
 * the endpoint never reveals whether the address is registered.
 */
export const invite = async (
  ownerId: string,
  input: BuddyInput,
): Promise<IBuddy> => {
  const owner = await User.findById(ownerId);
  if (!owner) throw AppError.unauthorized();

  if (input.email === owner.email) {
    throw AppError.badRequest(
      'You cannot add yourself as your own buddy.',
      'buddy_is_self',
    );
  }

  const existing = await Buddy.findOne({
    owner: ownerId,
    inviteEmail: input.email,
  });
  if (
    existing &&
    (existing.status === 'pending' || existing.status === 'active')
  ) {
    throw AppError.conflict(
      'You have already invited that person.',
      'buddy_exists',
    );
  }

  const count = await Buddy.countDocuments({
    owner: ownerId,
    status: { $in: ['pending', 'active'] },
  });
  if (count >= config.buddies.max) {
    throw AppError.badRequest(
      `You can have at most ${config.buddies.max} buddies.`,
      'buddy_limit_reached',
    );
  }

  const buddyUser = await User.findOne({ email: input.email });

  // identity is the HUMAN, not the address: after the buddy changes their
  // email, re-inviting the new address must not create a second live link to
  // the same person (which would double their full-pack mails and burn slots)
  if (buddyUser) {
    const sameHuman = await Buddy.findOne({
      owner: ownerId,
      buddy: buddyUser._id,
      status: { $in: ['pending', 'active'] },
    });
    if (sameHuman && sameHuman.inviteEmail !== input.email) {
      throw AppError.conflict(
        'You have already invited that person.',
        'buddy_exists',
      );
    }
  }

  let link: IBuddy;
  if (existing) {
    // a previously declined/revoked link is re-invited in place
    existing.status = 'pending';
    existing.invitedAt = new Date();
    existing.set('respondedAt', undefined);
    existing.set('buddy', buddyUser?._id); // undefined leaves it unbound
    if (input.name) existing.inviteName = input.name;
    link = await existing.save();
  } else {
    try {
      link = await Buddy.create({
        owner: ownerId,
        ...(buddyUser ? { buddy: buddyUser._id } : {}),
        inviteEmail: input.email,
        ...(input.name ? { inviteName: input.name } : {}),
        invitedAt: new Date(),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw AppError.conflict(
          'You have already invited that person.',
          'buddy_exists',
        );
      }
      throw error;
    }
  }

  sendInviteEmail(input.email, owner.name, Boolean(buddyUser));
  return link;
};

export const listForOwner = async (
  ownerId: string,
): Promise<Record<string, unknown>[]> => {
  const links = await Buddy.find({ owner: ownerId })
    .sort({ createdAt: -1 })
    .populate('buddy');
  return links.map((link) =>
    toOwnerView(link, link.buddy as unknown as IUser | null),
  );
};

export const removeForOwner = async (
  ownerId: string,
  linkId: string,
): Promise<void> => {
  const result = await Buddy.updateOne(
    { _id: linkId, owner: ownerId, status: { $ne: 'revoked' } },
    { $set: { status: 'revoked', respondedAt: new Date() } },
  );
  if (result.matchedCount === 0) {
    throw AppError.notFound('Buddy not found.', 'buddy_not_found');
  }
};

// --- buddy side -------------------------------------------------------------

/** Invitations addressed to this user that still await a response. */
export const listInvitesForBuddy = async (
  userId: string,
): Promise<Record<string, unknown>[]> => {
  const links = await Buddy.find({ buddy: userId, status: 'pending' })
    .sort({ createdAt: -1 })
    .populate('owner');
  return links.map((link) =>
    toInviteView(link, link.owner as unknown as IUser | null),
  );
};

/**
 * The buddy's own answer, in-app. Atomically claims the pending link, so a
 * concurrent double-tap records exactly one response.
 */
export const respondToInvite = async (
  userId: string,
  linkId: string,
  action: 'accept' | 'decline',
): Promise<IBuddy> => {
  const link = await Buddy.findOneAndUpdate(
    { _id: linkId, buddy: userId, status: 'pending' },
    {
      $set: {
        status: action === 'accept' ? 'active' : 'declined',
        respondedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!link) {
    throw AppError.notFound('Invitation not found.', 'invite_not_found');
  }
  return link;
};

/**
 * Binds pending invites addressed to an email to the user who just proved
 * ownership of it (signup OTP). Called once, at first verification. Idempotent.
 */
export const bindPendingInvites = async (user: IUser): Promise<void> => {
  if (!user.email) return;
  await Buddy.updateMany(
    { inviteEmail: user.email, buddy: { $exists: false }, status: 'pending' },
    { $set: { buddy: user._id } },
  );
};

/** Emails of the owner's ACCEPTED buddies - the alert fan-out (delivery.service).
 *  Deduplicated: two historical links resolving to one human's current email
 *  must not double their mail. */
export const activeBuddyEmails = async (ownerId: string): Promise<string[]> => {
  const links = await Buddy.find({ owner: ownerId, status: 'active' }).populate(
    'buddy',
  );
  const emails = links
    .map((link) => (link.buddy as unknown as IUser | null)?.email)
    .filter((email): email is string => Boolean(email));
  return [...new Set(emails)];
};

/** User ids of ACCEPTED buddies - the push fan-out (delivery.service). */
export const activeBuddyUserIds = async (
  ownerId: string,
): Promise<string[]> => {
  const links = await Buddy.find({
    owner: ownerId,
    status: 'active',
    buddy: { $exists: true },
  }).select('buddy');
  const ids = links
    .map((link) => link.buddy?.toString())
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
};
