import type { Request, Response } from 'express';
import * as buddyService from '../services/buddy.service';
import * as episodeService from '../services/episode.service';
import { authContext } from '../middlewares/auth.middleware';
import type { BuddyInput } from '../validation/buddy.schema';

// --- owner side -------------------------------------------------------------

export const invite = async (req: Request, res: Response): Promise<void> => {
  const link = await buddyService.invite(
    authContext(req).userId,
    req.body as BuddyInput,
  );
  res.status(201).json({
    buddy: {
      id: link._id.toString(),
      email: link.inviteEmail,
      status: link.status,
    },
  });
};

export const list = async (req: Request, res: Response): Promise<void> => {
  const buddies = await buddyService.listForOwner(authContext(req).userId);
  res.status(200).json({ buddies });
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  await buddyService.removeForOwner(authContext(req).userId, id);
  res.status(204).send();
};

// --- buddy side -------------------------------------------------------------

export const listInvites = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const invites = await buddyService.listInvitesForBuddy(
    authContext(req).userId,
  );
  res.status(200).json({ invites });
};

/** Owners I protect, with their devices. */
export const listProtected = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const people = await buddyService.listProtected(authContext(req).userId);
  res.status(200).json({ people });
};

/** Report a friend's phone stolen on their behalf; alerts go out as usual. */
export const reportStolen = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  const { note } = req.body as { note?: string };
  const { episode, created } = await episodeService.reportStolenAsBuddy(
    authContext(req).userId,
    id,
    note,
  );
  // the buddy sees that it worked, not the owner's incident record
  res.status(created ? 201 : 200).json({
    episode: {
      id: episode._id.toString(),
      status: episode.status,
      openedAt: episode.openedAt.toISOString(),
    },
  });
};

export const respond = async (req: Request, res: Response): Promise<void> => {
  const { id, action } = req.params as {
    id: string;
    action: 'accept' | 'decline';
  };
  const link = await buddyService.respondToInvite(
    authContext(req).userId,
    id,
    action,
  );
  res
    .status(200)
    .json({ invite: { id: link._id.toString(), status: link.status } });
};
