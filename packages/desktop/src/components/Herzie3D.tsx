import {
	type CreatureParams,
	Herzie3D as SharedHerzie3D,
	Sky,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { useWindowFocused } from "../tauri-bridge";

interface Props {
	userId: string;
	stage?: number;
	size?: number;
	animate?: boolean;
	isPlaying?: boolean;
	wearables?: string[];
	creatureParams?: CreatureParams;
	showSky?: boolean;
	draggable?: boolean;
}

/**
 * Desktop-tuned composition of the shared Sky + Herzie3D primitives.
 *
 * The Tauri window is fixed-size (380×520, borderless), so the sky is anchored
 * to the window's top edge and the drag area spans the full window width.
 */
export function Herzie3D({
	userId,
	stage = 1,
	size = 5,
	animate,
	isPlaying = false,
	wearables,
	creatureParams,
	showSky = true,
	draggable,
}: Props) {
	const [sceneryCols, setSceneryCols] = useState(() =>
		Math.floor(window.innerWidth / (size * 0.6)),
	);

	useEffect(() => {
		const onResize = () => {
			setSceneryCols(Math.floor(window.innerWidth / (size * 0.6)));
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [size]);

	const focused = useWindowFocused();
	const paused = !focused;

	return (
		<>
			{showSky && (
				<Sky
					userId={userId}
					isPlaying={isPlaying}
					cols={sceneryCols}
					size={size}
					paused={paused || animate === false}
					style={{
						position: "fixed",
						top: 0,
						left: 0,
						width: "100vw",
						zIndex: 0,
					}}
				/>
			)}
			<SharedHerzie3D
				userId={userId}
				stage={stage}
				size={size}
				animate={animate}
				isPlaying={isPlaying}
				wearables={wearables}
				creatureParams={creatureParams}
				draggable={draggable}
				paused={paused}
				wrapperStyle={
					showSky
						? {
								position: "relative",
								width: "100vw",
								marginLeft: "calc(-50vw + 50%)",
							}
						: undefined
				}
			/>
		</>
	);
}
