import Icon, { reasonIconName, stripEmoji } from './Icon';

// Renders a scoring reason ("👪 Possible family") as an icon chip with clean text.
export default function ReasonTag({ text }) {
  return (
    <span className="reason-tag">
      <Icon name={reasonIconName(text)} size={13} strokeWidth={2.25} />
      {stripEmoji(text)}
    </span>
  );
}
