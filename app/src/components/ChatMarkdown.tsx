import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export function ChatMarkdown({text}:{text:string}){
 return <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{a:props=><a href={props.href} target="_blank" rel="noopener noreferrer">{props.children}</a>}}>{text}</Markdown></div>;
}
