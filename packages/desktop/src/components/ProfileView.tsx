import { Herzie3D, type HerzieProfile } from "@herzies/shared";
import { useState } from "react";
import { BackButton } from "./BackButton";
import { View } from "./View";

export function ProfileView({
  profile,
  onBack,
  onTrade,
  onRemove,
  stageOverride,
}: {
  profile: HerzieProfile;
  onBack: () => void;
  onTrade: () => void;
  onRemove: () => void;
  stageOverride?: number | null;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <View
      title={profile.name}
      backButton={<BackButton colour="green" onClick={onBack} />}
      action={profile.name}
      colour="green"
      childrenClassName="flex min-h-0 flex-col"
    >
      {profile.friendCode && (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Herzie3D
            userId={profile.friendCode}
            stage={stageOverride ?? profile.stage}
            wearables={profile.equipped ?? []}
          />
        </div>
      )}

      <div className="mb-2 flex justify-between text-ui text-text-dim">
        <span>Level {profile.level}</span>
        <span>Stage {profile.stage}</span>
      </div>

      {profile.topArtists && profile.topArtists.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-text-dim">Top Artists</div>
          {profile.topArtists.map((a, i) => (
            <div
              key={a.name}
              className="flex justify-between border-b border-[#222] py-0.5 text-ui"
            >
              <span className="text-text">
                {i + 1}. {a.name}
              </span>
              <span className="text-text-dim">{a.plays} plays</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex shrink-0 gap-1.5">
        <button type="button" className="btn text-purple" onClick={onTrade}>
          Trade
        </button>
        {confirmRemove ? (
          <>
            <button type="button" className="btn text-red" onClick={onRemove}>
              Yes, remove
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmRemove(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn text-red"
            onClick={() => setConfirmRemove(true)}
          >
            Remove friend
          </button>
        )}
      </div>
    </View>
  );
}
